# Setup and testing guide

This guide covers setting up the extension for development and testing it on macOS, Windows, or Linux. The extension runs in the local VS Code UI extension host, detects that host's operating system and CPU architecture at activation, and uses the matching `agent-rdp` native runtime. The remote computer must be reachable over RDP.

## Requirements

- VS Code Desktop (not the browser version)
- Node.js 22 or newer and npm
- Git
- A supported local extension host: macOS (Apple Silicon or Intel), Windows (x64 or ARM64), or Linux (x64 or ARM64)
- A remote machine with RDP enabled and reachable on TCP port 3389
- SSH on TCP port 22 if you want to test the integrated terminal, SFTP, or xRDP reset command

For a Linux remote desktop, install and configure xRDP and a desktop environment (the current working setup uses Ubuntu with XFCE). Permit TCP 3389 in the remote machine's firewall and cloud security rules. Only expose SSH and RDP to trusted source IPs.

## Get the source

Clone the repository and open its folder in VS Code:

```sh
git clone https://github.com/dutchmanApi/AI-Remote-Desktop-RDP-SSH-SFTP.git
cd AI-Remote-Desktop-RDP-SSH-SFTP
code .
```

## macOS setup and run

1. Install Node.js 22 or newer, Git, and VS Code.
2. Open the project folder in VS Code.
3. In the integrated terminal, install dependencies and compile:

   ```sh
   npm install
   npm run compile
   ```

4. Press **F5** (or choose **Run Extension** from the Run and Debug view). VS Code opens an **Extension Development Host** window with the extension loaded.
5. In that window, select the **Cloud RDP Manager** icon in the Activity Bar.
6. Select **+** and enter a friendly name, remote host/IP, SSH/RDP username, and the Linux/RDP password. The password is stored using VS Code SecretStorage.
7. Select the server's desktop action to open **Embedded RDP Desktop**. Accept the password prompt if shown.
8. For SSH/SFTP, expand the server in the view or choose **Open SSH Terminal** from its context menu.

The checked-in VS Code launch configuration compiles the extension before launching the development host. `npm run compile` can also be run manually after code changes.

## Windows setup and run

1. Install Node.js 22 or newer for Windows, Git for Windows, and VS Code Desktop.
2. Clone and open the project folder:

   ```powershell
   git clone https://github.com/dutchmanApi/AI-Remote-Desktop-RDP-SSH-SFTP.git
   cd AI-Remote-Desktop-RDP-SSH-SFTP
   code .
   ```

3. In the VS Code integrated PowerShell terminal, install dependencies and compile:

   ```powershell
   npm ci
   npm run compile
   ```

   `agent-rdp` declares optional native binaries for Windows x64 and ARM64. Do not add a macOS-specific `@agent-rdp/darwin-arm64` dependency; npm selects the correct optional package for the development machine.

4. Press **F5** to launch the Extension Development Host.
5. In the development host, use **Cloud RDP Manager** to add the same reachable test server and open its embedded desktop.
6. Verify that the desktop renders and accepts keyboard/mouse input. Also try the SSH terminal and SFTP if TCP 22 is enabled for your machine.

### Windows verification checklist

- `npm ci` finishes without an `EBADPLATFORM` error.
- `npm run compile` succeeds.
- The Extension Development Host starts without a native `agent-rdp` binary load error.
- The embedded RDP panel shows a desktop image and receives updates.
- Keyboard and mouse input reaches the remote desktop.
- SSH terminal/SFTP work when the host permits SSH from the Windows test machine.
- Close the panel, reopen it, and verify a new session can connect.

## Linux setup and run

1. Install Node.js 22 or newer, Git, and VS Code Desktop on Linux x64 or ARM64.
2. Clone and open the project folder, then install and compile:

   ```sh
   git clone https://github.com/dutchmanApi/AI-Remote-Desktop-RDP-SSH-SFTP.git
   cd AI-Remote-Desktop-RDP-SSH-SFTP
   npm ci
   npm run compile
   ```

3. Press **F5** to launch the Extension Development Host.
4. Open **Cloud RDP Manager**, add a reachable server, and verify RDP display/input, SSH, and SFTP.

The extension logs the selected host runtime in the Extension Host output. Supported runtime packages are macOS x64/ARM64, Windows x64/ARM64, and Linux x64/ARM64. Linux testing instructions are provided, but confirm your exact Linux distribution and architecture before publishing it as tested.

Repeat runtime checks after changes to native dependencies, RDP streaming, or packaging. If a check fails, capture the exact `npm ci`/compile output and the Extension Development Host **Output** or **Developer Tools** console error.

## Troubleshooting

- **Cannot connect:** Confirm the host/IP and that TCP 3389 is reachable from the test machine. For Linux targets, confirm the xRDP service is active.
- **SSH terminal or SFTP cannot connect:** Confirm SSH is listening on TCP 22 and the server allows the test machine's source IP.
- **Connected but blank desktop:** First verify the same host and account in another RDP client. If the other client also shows a blank screen, inspect the remote desktop session; if it works, capture the Extension Development Host console output.
- **`EBADPLATFORM`:** Do not add a direct dependency on a platform-specific `@agent-rdp` package. `agent-rdp` declares these as optional dependencies so npm can select the local runtime.
- **`EADDRINUSE` from SFTP:** Refresh the server tree, close duplicate SSH terminals/tunnels, and retry. This is a local port allocation error, not evidence that RDP is unavailable.

## Package and install the extension locally

From the project directory, install dependencies on the target operating system and create its VSIX:

```sh
npm ci
npm run package
```

`npm run package` detects the local OS and architecture and asks `vsce` to set the corresponding target. Build and publish on every target you intend to support: macOS x64/ARM64, Windows x64/ARM64, and Linux x64/ARM64. The runtime cannot be cross-packaged from another OS because npm installs only the host's matching optional native dependency. Do not upload one machine's package as a universal build.

Install the generated target-specific `.vsix` into VS Code using **Extensions: Install from VSIX...**. Test the packaged extension on each supported OS before publishing; the Extension Development Host test alone does not verify packaging.

For Marketplace submission, publisher setup, and release steps, see [PUBLISHING.md](./PUBLISHING.md).
