export interface ExtensionRuntime {
    platform: string;
    arch: string;
    displayName: string;
    nativePackage?: string;
    vsceTarget?: string;
}

const runtimes: Record<string, Omit<ExtensionRuntime, 'platform' | 'arch'>> = {
    'darwin-arm64': {
        displayName: 'macOS Apple Silicon',
        nativePackage: '@agent-rdp/darwin-arm64',
        vsceTarget: 'darwin-arm64'
    },
    'darwin-x64': {
        displayName: 'macOS Intel',
        nativePackage: '@agent-rdp/darwin-x64',
        vsceTarget: 'darwin-x64'
    },
    'win32-arm64': {
        displayName: 'Windows ARM64',
        nativePackage: '@agent-rdp/win32-arm64',
        vsceTarget: 'win32-arm64'
    },
    'win32-x64': {
        displayName: 'Windows x64',
        nativePackage: '@agent-rdp/win32-x64',
        vsceTarget: 'win32-x64'
    },
    'linux-arm64': {
        displayName: 'Linux ARM64',
        nativePackage: '@agent-rdp/linux-arm64',
        vsceTarget: 'linux-arm64'
    },
    'linux-x64': {
        displayName: 'Linux x64',
        nativePackage: '@agent-rdp/linux-x64',
        vsceTarget: 'linux-x64'
    }
};

export function detectExtensionRuntime(
    platform: string = process.platform,
    arch: string = process.arch
): ExtensionRuntime {
    const key = `${platform}-${arch}`;
    return {
        platform,
        arch,
        displayName: runtimes[key]?.displayName ?? `Unsupported platform (${platform}, ${arch})`,
        nativePackage: runtimes[key]?.nativePackage,
        vsceTarget: runtimes[key]?.vsceTarget
    };
}

export function supportedRuntimeTargets(): string[] {
    return Object.keys(runtimes);
}
