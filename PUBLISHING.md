# VS Code Marketplace publishing checklist

The extension is configured for the Marketplace publisher `Sarifkhan`. The display name is **AI Remote Desktop: RDP, SSH & SFTP**; the Marketplace extension identifier will be `Sarifkhan.ai-remote-desktop-rdp-ssh-sftp`.

## Before the first release

1. Make sure the GitHub repository is public and the latest tested source is pushed to `main`.
2. Sign in to the [Visual Studio Marketplace publisher management page](https://marketplace.visualstudio.com/manage) with the Microsoft account that owns the `Sarifkhan` publisher. Publisher IDs cannot be changed after creation.
3. Review the listing name, summary, keywords, README, changelog, license, and publisher details in `package.json`. Add a 128x128-or-larger PNG icon and set its path in `package.json` before publishing; the current SVG source is not a Marketplace-compatible icon.
4. Build and test a clean platform-specific install on every supported OS:

   ```sh
   npm ci
   npm run compile
   npm run package
   ```

   Run these commands on each target OS. `npm run package` creates an OS/architecture-specific VSIX using that machine's native `agent-rdp` optional dependency. Never publish a macOS-built VSIX as a universal package for Windows.
5. Install the generated `.vsix` in each OS using **Extensions: Install from VSIX...** and verify RDP display/input, SSH, and SFTP.
6. Inspect the package contents and size before release:

   ```sh
   npx @vscode/vsce ls
   ```

   Confirm it contains the compiled extension, the matching `@agent-rdp/<platform>-<arch>` native package, production dependencies, README, changelog, license, and required third-party notices, but not development-only files or secrets.

## Submit the first release

1. Create a [Marketplace Personal Access Token](https://learn.microsoft.com/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate) scoped to **Marketplace: Publish**. Keep it private; never commit it or paste it into source files.
2. In the project directory, authenticate `vsce`:

   ```sh
   npx vsce login Sarifkhan
   ```

   Paste the PAT only into the interactive prompt.
3. On each target OS, publish the same version as a platform-specific build:

   ```sh
   npm run publish
   ```

   The command detects the current OS/architecture and publishes that target. Run it on macOS and Windows using the same `package.json` version. Alternatively, upload each generated target-specific VSIX from the publisher management page.
4. Open the listing and verify its title, icon, README rendering, install instructions, and links. Marketplace indexing and install counts may take time to appear.
5. For later releases, update `CHANGELOG.md`, increment the SemVer version in `package.json`, run the clean cross-platform checks, then package and publish again.

For automated releases, prefer Marketplace Trusted Publishing with GitHub Actions OIDC over storing a long-lived PAT. Follow the [official VS Code publishing instructions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension).

## Launch and growth plan

There is no reliable way to guarantee 10,000 installs in a month. Treat that as a stretch target, not a forecast. Focus on the users who need a remote desktop inside their editor and on making the listing credible and easy to evaluate.

### Before launch

- Add genuine screenshots or a short, captioned demo GIF showing setup, a live desktop, and the SSH/SFTP workflows. Do not use mockups that imply unimplemented features.
- Test install, update, uninstall, credentials, and reconnect on Windows and macOS. Publish a clear known-limitations section.
- Ask a small group of cloud developers and operators to test the VSIX and report friction. Fix onboarding issues before broad promotion.
- Prepare a 60-90 second demo, a concise project page, and one practical tutorial such as “Open a cloud VM desktop without leaving VS Code.”

### First 30 days

1. **Launch day:** publish the extension, verify the Marketplace page, and announce it from the project’s GitHub and the maintainer’s professional channels.
2. **Week 1:** share the demo and tutorial in communities whose rules allow project announcements (VS Code, cloud/DevOps, and relevant language communities). Explain the use case, limitations, and security model; do not spam unrelated groups.
3. **Week 2:** write a search-focused tutorial for actual user queries such as “RDP in VS Code,” “SSH and SFTP in VS Code,” and “remote desktop for a cloud VM.” Link to the Marketplace listing naturally.
4. **Week 3:** ask early users for specific, honest feedback and fix the most common onboarding or stability issue. Request reviews only from users who have genuinely tried it; never buy installs or reviews.
5. **Week 4:** publish a release note/demo of improvements, answer issues promptly, and repeat promotion in the channels that produced engaged users.

### Measure what is working

- Check Marketplace acquisition trends and ratings in publisher management weekly.
- Track listing views, installs, reviews, issue reports, and the ratio of installs to views where analytics are available.
- Use a simple release log to compare which posts/tutorials led to traffic; do not collect credentials or unnecessary personal data.
- If views are low, improve search wording and distribution. If views are high but installs are low, improve the icon, screenshots, setup clarity, or trust signals. If installs are high but users leave, focus on reliability and onboarding.

The strongest long-term growth drivers are a clear differentiated use case, truthful screenshots, reliable cross-platform behavior, fast support, and useful releases—not keyword stuffing or an install-count promise.
