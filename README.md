# AI Remote Desktop: RDP, SSH & SFTP

Connect to cloud servers without leaving VS Code. Manage saved hosts in the **Cloud RDP Manager** activity bar view.

## Features

- **Embedded RDP desktop** with screen fitting, keyboard, and mouse input.
- **SSH terminal** for interactive server administration.
- **SFTP file browsing** from the server tree.
- **Credential protection** using VS Code SecretStorage for saved passwords.
- **Cross-platform client** for macOS, Windows, and Linux (x64 and ARM64). At startup, the extension detects the local VS Code extension host's OS and architecture; `agent-rdp` loads the matching native runtime.

The embedded desktop uses [`agent-rdp`](https://github.com/thisnick/agent-rdp), an RDP engine designed for AI agents. This extension provides a human-operated VS Code desktop and does not add an AI chat or model integration. Docker and Apache Guacamole are not required.

## Get started

1. Install **AI Remote Desktop: RDP, SSH & SFTP** from the VS Code Marketplace.
2. Select **Cloud RDP Manager** in the Activity Bar and choose **Add Cloud Server**.
3. Enter a display name, host/IP, username, and password.
4. Open **Embedded RDP Desktop** to connect over port 3389. Use the server context menu to open an SSH terminal or browse SFTP over port 22.

The remote server must allow connections from your device. Linux desktops need a configured RDP service such as xRDP. Only expose SSH and RDP to trusted source IPs.

## Develop and test

See the [setup and testing guide](./SETUP.md) for running the extension on macOS, Windows, and Linux.

See the [Marketplace publishing guide](./PUBLISHING.md) for packaging and submission.

If SFTP reports `EADDRINUSE`, refresh the server tree, close duplicate SSH terminals or tunnels, and retry. This is a local socket allocation error raised before SSH authentication; it does not mean an AWS VPN is required.

## Privacy and licensing

Server credentials are stored in VS Code SecretStorage. RDP and SSH traffic goes directly between the extension host and the configured server; the project does not provide a hosted relay. This project is MIT-licensed. Bundled third-party components retain their own licenses and notices in `media/`.
