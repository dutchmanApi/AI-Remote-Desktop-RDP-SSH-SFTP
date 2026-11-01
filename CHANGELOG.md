# Change Log

All notable changes to the "AI Remote Desktop: RDP, SSH & SFTP" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.3.0] - 2026-11-01

- Detect the local VS Code extension host OS and architecture at activation and select its matching RDP runtime.
- Report a clear error for unsupported hosts or when the platform-specific runtime package is missing.
- Declare the extension as a UI extension so the runtime is selected on the local VS Code machine in remote workspaces.
- Add Linux x64/ARM64 documentation and platform selector tests.
- Reset the xRDP session over SSH before opening the embedded desktop to reduce black-screen startup failures.

## [0.2.1] - 2026-11-01

- Package platform-specific native RDP binaries for each operating system.
- Apply the Windows IPC compatibility fix during dependency installation.

## [0.2.2] - 2026-11-01

- Retry startup screenshots and report when the display stream does not deliver frames.
- Avoid sending mouse and keyboard input before the daemon connection is ready.
- Surface daemon disconnects and log the first rendered desktop frame.