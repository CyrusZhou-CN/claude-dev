import fs from "fs/promises"
import os from "os"
import * as path from "path"
import simpleGit, { SimpleGit } from "simple-git"
import * as vscode from "vscode"
import { ClineProvider } from "../../core/webview/ClineProvider"
import { fileExistsAtPath } from "../../utils/fs"
import { getLfsPatterns, writeExcludesFile, shouldExcludeFile } from "./CheckpointExclusions"

/**
 * CheckpointTracker Module
 *
 * Core implementation of Cline's Checkpoints system that provides version control
 * capabilities without interfering with the user's main Git repository. Key features:
 *
 * Shadow Git Repository:
 * - Creates and manages an isolated Git repository for tracking checkpoints
 * - Handles nested Git repositories by temporarily disabling them
 * - Configures Git settings automatically (identity, LFS, etc.)
 *
 * File Management:
 * - Integrates with CheckpointExclusions for file filtering
 * - Handles workspace validation and path resolution
 * - Manages Git worktree configuration
 *
 * Checkpoint Operations:
 * - Creates checkpoints (commits) of the current state
 * - Provides diff capabilities between checkpoints
 * - Supports resetting to previous checkpoints
 *
 * Safety Features:
 * - Prevents usage in sensitive directories (home, desktop, etc.)
 * - Validates workspace configuration
 * - Handles cleanup and resource disposal
 *
 * The module serves as the backbone of Cline's checkpoint system, enabling
 * reliable progress tracking while maintaining isolation from the user's
 * primary version control.
 */

class CheckpointTracker {
	private providerRef: WeakRef<ClineProvider>
	private taskId: string
	private disposables: vscode.Disposable[] = []
	private cwd: string
	private cwdHash: string
	private lastRetrievedShadowGitConfigWorkTree?: string
	lastCheckpointHash?: string


	private constructor(provider: ClineProvider, taskId: string, cwd: string, cwdHash: string) {
		this.providerRef = new WeakRef(provider)
		this.taskId = taskId
		this.cwd = cwd
		this.cwdHash = cwdHash
	}


	public static async create(taskId: string, provider?: ClineProvider): Promise<CheckpointTracker | undefined> {
		try {
			if (!provider) {
				throw new Error("Provider is required to create a checkpoint tracker")
			}

			// Check if checkpoints are disabled in VS Code settings
			const enableCheckpoints = vscode.workspace.getConfiguration("cline").get<boolean>("enableCheckpoints") ?? true
			if (!enableCheckpoints) {
				return undefined // Don't create tracker when disabled
			}

			// Check if git is installed by attempting to get version
			try {
				await simpleGit().version()
			} catch (error) {
				throw new Error("Git must be installed to use checkpoints.") // FIXME: must match what we check for in TaskHeader to show link
			}

			const workingDir = await CheckpointTracker.getWorkingDirectory()
			const cwdHash = CheckpointTracker.hashWorkingDir(workingDir)
			console.log("cwd: ", workingDir)
			console.log("working dir hash: ", cwdHash)


			const newTracker = new CheckpointTracker(provider, taskId, workingDir, cwdHash)
			await newTracker.initShadowGit(cwdHash)
			await newTracker.switchToTaskBranch()
			return newTracker
		} catch (error) {
			console.error("Failed to create CheckpointTracker:", error)
			throw error
		}
	}

	// Create a unique hash for the working directory
	// This is used to identify the working directory in the shadow git repository
	// TODO - Replace with method that accomates repo renames and movement
	private static hashWorkingDir(workingDir: string): string {
		let hash = 0;
		for (let i = 0; i < workingDir.length; i++) {
			hash = (hash * 31 + workingDir.charCodeAt(i)) >>> 0;
		}
		const bigHash = BigInt(hash);
		const numericHash = bigHash.toString().slice(0, 13);
		return numericHash;
	}

	private static async getWorkingDirectory(): Promise<string> {
		const cwd = vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath).at(0)
		if (!cwd) {
			throw new Error("No workspace detected. Please open Cline in a workspace to use checkpoints.")
		}
		const homedir = os.homedir()
		const desktopPath = path.join(homedir, "Desktop")
		const documentsPath = path.join(homedir, "Documents")
		const downloadsPath = path.join(homedir, "Downloads")

		switch (cwd) {
			case homedir:
				throw new Error("Cannot use checkpoints in home directory")
			case desktopPath:
				throw new Error("Cannot use checkpoints in Desktop directory")
			case documentsPath:
				throw new Error("Cannot use checkpoints in Documents directory")
			case downloadsPath:
				throw new Error("Cannot use checkpoints in Downloads directory")
			default:
				return cwd
		}
	}

	// Get path to shadow Git in globalStorage
	private async getShadowGitPath(): Promise<string> {
		const globalStoragePath = this.providerRef.deref()?.context.globalStorageUri.fsPath
		if (!globalStoragePath) {
			throw new Error("Global storage uri is invalid")
		}
		const checkpointsDir = path.join(globalStoragePath, "checkpoints", this.cwdHash)
		await fs.mkdir(checkpointsDir, { recursive: true })
		const gitPath = path.join(checkpointsDir, ".git")
		return gitPath
	}

	// New method to create/switch to task branch
	private async switchToTaskBranch(): Promise<void> {
		const git = simpleGit(path.dirname(await this.getShadowGitPath()))
		const branchName = `task-${this.taskId}`

		// Check if branch exists
		const branches = await git.branchLocal()
		if (!branches.all.includes(branchName)) {
		await git.checkoutLocalBranch(branchName)
		} else {
		await git.checkout(branchName)
		}
	}

	// Check to see if shadow Git already exists for the workspace
	public static async doesShadowGitExist(taskId: string, provider?: ClineProvider): Promise<boolean> {
		const globalStoragePath = provider?.context.globalStorageUri.fsPath
		if (!globalStoragePath) {
			return false
		}
		// Get working directory hash
		const workingDir = await CheckpointTracker.getWorkingDirectory()
		const cwdHash = CheckpointTracker.hashWorkingDir(workingDir)
		const gitPath = path.join(globalStoragePath, "checkpoints", cwdHash, ".git")
		return await fileExistsAtPath(gitPath)
	}

	// Initialize new shadow Git
	public async initShadowGit(cwdHash: string): Promise<string> {
		const gitPath = await this.getShadowGitPath()

		// If repo exists, just verify worktree
		if (await fileExistsAtPath(gitPath)) {
			const worktree = await this.getShadowGitConfigWorkTree()
			if (worktree !== this.cwd) {
				throw new Error("Checkpoints can only be used in the original workspace: " + worktree)
			}
			return gitPath
		}

		// Initialize new repo
		const checkpointsDir = path.dirname(gitPath)
		const git = simpleGit(checkpointsDir)
		await git.init()

		// Configure repo
		await git.addConfig("core.worktree", this.cwd)
		await git.addConfig("commit.gpgSign", "false")
		await git.addConfig("user.name", "Cline Checkpoint")
		await git.addConfig("user.email", "noreply@example.com")

		// Set up LFS patterns
		const lfsPatterns = await getLfsPatterns(this.cwd)
		await writeExcludesFile(gitPath, lfsPatterns)

		// Initial commit only on first repo creation
		await git.commit("initial commit", { "--allow-empty": null })

		return gitPath
	}

	public async getShadowGitConfigWorkTree(): Promise<string | undefined> {
		if (this.lastRetrievedShadowGitConfigWorkTree) {
			return this.lastRetrievedShadowGitConfigWorkTree
		}
		try {
			const gitPath = await this.getShadowGitPath()
			const git = simpleGit(path.dirname(gitPath))
			const worktree = await git.getConfig("core.worktree")
			this.lastRetrievedShadowGitConfigWorkTree = worktree.value || undefined
			return this.lastRetrievedShadowGitConfigWorkTree
		} catch (error) {
			console.error("Failed to get shadow git config worktree:", error)
			return undefined
		}
	}

	public async commit(): Promise<string | undefined> {
		try {
			const gitPath = await this.getShadowGitPath()
			const git = simpleGit(path.dirname(gitPath))
			await this.switchToTaskBranch()
			await this.addCheckpointFiles(git)
			const result = await git.commit("checkpoint", {
				"--allow-empty": null,
			})
			const commitHash = result.commit || ""
			this.lastCheckpointHash = commitHash
			return commitHash
		} catch (error) {
			console.error("Failed to create checkpoint:", error)
			return undefined
		}
	}

	public async resetHead(commitHash: string): Promise<void> {
		const gitPath = await this.getShadowGitPath()
		const git = simpleGit(path.dirname(gitPath))
		await this.switchToTaskBranch()
		await git.reset(["--hard", commitHash]) // Hard reset to target commit
	}

	/**
	 * Return an array describing changed files between one commit and either:
	 *   - another commit, or
	 *   - the current working directory (including uncommitted changes).
	 *
	 * If `rhsHash` is omitted, compares `lhsHash` to the working directory.
	 * If you want truly untracked files to appear, `git add` them first.
	 *
	 * @param lhsHash - The commit to compare from (older commit)
	 * @param rhsHash - The commit to compare to (newer commit).
	 *                  If omitted, we compare to the working directory.
	 * @returns Array of file changes with before/after content
	 */
	public async getDiffSet(
		lhsHash?: string,
		rhsHash?: string,
	): Promise<
		Array<{
			relativePath: string
			absolutePath: string
			before: string
			after: string
		}>
	> {
		const gitPath = await this.getShadowGitPath()
		const git = simpleGit(path.dirname(gitPath))
		await this.switchToTaskBranch()

		// If lhsHash is missing, use the initial commit of the repo
		let baseHash = lhsHash
		if (!baseHash) {
			const rootCommit = await git.raw(["rev-list", "--max-parents=0", "HEAD"])
			baseHash = rootCommit.trim()
		}

		// Stage all changes so that untracked files appear in diff summary
		await this.addCheckpointFiles(git)

		const diffSummary = rhsHash ? await git.diffSummary([`${baseHash}..${rhsHash}`]) : await git.diffSummary([baseHash])

		// For each changed file, gather before/after content
		const result = []
		const cwdPath = (await this.getShadowGitConfigWorkTree()) || this.cwd || ""

		for (const file of diffSummary.files) {
			const filePath = file.file
			const absolutePath = path.join(cwdPath, filePath)

			let beforeContent = ""
			try {
				beforeContent = await git.show([`${baseHash}:${filePath}`])
			} catch (_) {
				// file didn't exist in older commit => remains empty
			}

			let afterContent = ""
			if (rhsHash) {
				// if user provided a newer commit, use git.show at that commit
				try {
					afterContent = await git.show([`${rhsHash}:${filePath}`])
				} catch (_) {
					// file didn't exist in newer commit => remains empty
				}
			} else {
				// otherwise, read from disk (includes uncommitted changes)
				try {
					afterContent = await fs.readFile(absolutePath, "utf8")
				} catch (_) {
					// file might be deleted => remains empty
				}
			}

			result.push({
				relativePath: filePath,
				absolutePath,
				before: beforeContent,
				after: afterContent,
			})
		}

		return result
	}

	/**
	 * Adds files to the shadow git repository while handling nested git repos and applying exclusion rules.
	 * Uses git commands to list files, then applies our custom exclusions.
	 */
	private async addCheckpointFiles(git: SimpleGit): Promise<void> {
		try {
			await this.renameNestedGitRepos(true)
			console.log("Starting checkpoint add operation...")

			// Get list of all files git would track (respects .gitignore)
			const gitFiles = (await git.raw(["ls-files", "--others", "--exclude-standard", "--cached"]))
				.split("\n")
				.filter(Boolean)
			console.log(`Found ${gitFiles.length} files from git to check for exclusions`)

			const filesToAdd: string[] = []
			const excludedFiles: Array<{ path: string; reason: string }> = []

			// Apply our custom exclusions
			for (const relativePath of gitFiles) {
				const fullPath = path.join(this.cwd, relativePath)
				const exclusionResult = await shouldExcludeFile(fullPath)

				if (exclusionResult.excluded && exclusionResult.reason) {
					excludedFiles.push({
						path: relativePath,
						reason: exclusionResult.reason,
					})
				} else {
					filesToAdd.push(relativePath)
				}
			}

			// Log exclusions
			if (excludedFiles.length > 0) {
				console.log(`Excluded ${excludedFiles.length} files`)
			}

			// Add filtered files
			if (filesToAdd.length === 0) {
				console.log("No files to add to checkpoint")
				return
			}

			try {
				console.log(`Adding ${filesToAdd.length} files to checkpoint...`)
				await git.add(filesToAdd)
				console.log("Checkpoint add operation completed successfully")
			} catch (error) {
				console.error("Checkpoint add operation failed:", error)
				throw error
			}
		} catch (error) {
			console.error("Failed to add files to checkpoint:", error)
			throw error
		} finally {
			await this.renameNestedGitRepos(false)
		}
	}

	// Since we use git to track checkpoints, we need to temporarily disable nested git repos to work around git's requirement of using submodules for nested repos.
	private async renameNestedGitRepos(disable: boolean) {
		// Find all .git directories that are not at the root level using VS Code API
		const gitFiles = await vscode.workspace.findFiles(
			new vscode.RelativePattern(this.cwd, "**/.git" + (disable ? "" : GIT_DISABLED_SUFFIX)),
			new vscode.RelativePattern(this.cwd, ".git/**"), // Exclude root .git (note trailing comma)
		)

		// Filter to only include directories
		const gitPaths: string[] = []
		for (const file of gitFiles) {
			const relativePath = path.relative(this.cwd, file.fsPath)
			try {
				const stats = await fs.stat(path.join(this.cwd, relativePath))
				if (stats.isDirectory()) {
					gitPaths.push(relativePath)
				}
			} catch {
				// Skip if stat fails
				continue
			}
		}

		// For each nested .git directory, rename it based on the disable flag
		for (const gitPath of gitPaths) {
			const fullPath = path.join(this.cwd, gitPath)
			let newPath: string
			if (disable) {
				newPath = fullPath + GIT_DISABLED_SUFFIX
			} else {
				newPath = fullPath.endsWith(GIT_DISABLED_SUFFIX) ? fullPath.slice(0, -GIT_DISABLED_SUFFIX.length) : fullPath
			}

			try {
				await fs.rename(fullPath, newPath)
				console.log(`CheckpointTracker ${disable ? "disabled" : "enabled"} nested git repo ${gitPath}`)
			} catch (error) {
				console.error(`CheckpointTracker failed to ${disable ? "disable" : "enable"} nested git repo ${gitPath}:`, error)
			}
		}
	}

	public dispose() {
		this.disposables.forEach((d) => d.dispose())
		this.disposables = []
	}
}

export const GIT_DISABLED_SUFFIX = "_disabled"

export default CheckpointTracker

