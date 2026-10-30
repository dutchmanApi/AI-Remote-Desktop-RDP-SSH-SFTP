# Cloud RDP Commander

Manage cloud server profiles from the **Cloud RDP Manager** activity bar view. Add a server with its hostname or IP, SSH/RDP username, and password. Passwords are stored in VS Code SecretStorage.

The extension provides an embedded RDP desktop, an SSH terminal, and SFTP file browsing. The embedded desktop uses `agent-rdp`; Docker and Apache Guacamole are not required. The native `agent-rdp` binary is selected for the local operating system.

## Develop and test

See the [setup and testing guide](./SETUP.md) for step-by-step instructions for macOS and Windows, including running the extension in an Extension Development Host.

The remote machine must accept RDP connections on port 3389. SSH on port 22 is needed for the terminal, SFTP, and xRDP reset command. For Linux desktops, install and configure xRDP and a desktop environment such as XFCE on the remote machine.

If SFTP reports `EADDRINUSE`, refresh the server tree, close duplicate SSH terminals or tunnels, and retry. This is a local socket allocation error raised before SSH authentication; it does not mean an AWS VPN is required.
