const assert = require('node:assert/strict');
const test = require('node:test');
const { detectExtensionRuntime, supportedRuntimeTargets } = require('../out/platform.js');

test('selects the native runtime matching each supported host', () => {
    const cases = [
        ['darwin', 'arm64', '@agent-rdp/darwin-arm64'],
        ['darwin', 'x64', '@agent-rdp/darwin-x64'],
        ['win32', 'arm64', '@agent-rdp/win32-arm64'],
        ['win32', 'x64', '@agent-rdp/win32-x64'],
        ['linux', 'arm64', '@agent-rdp/linux-arm64'],
        ['linux', 'x64', '@agent-rdp/linux-x64']
    ];

    for (const [platform, arch, nativePackage] of cases) {
        const runtime = detectExtensionRuntime(platform, arch);
        assert.equal(runtime.nativePackage, nativePackage);
        assert.equal(runtime.vsceTarget, `${platform}-${arch}`);
        assert.ok(!runtime.displayName.startsWith('Unsupported'));
    }
});

test('does not map hosts without a native binary to a different runtime', () => {
    for (const [platform, arch] of [['linux', 'arm'], ['win32', 'ia32'], ['freebsd', 'x64']]) {
        const runtime = detectExtensionRuntime(platform, arch);
        assert.equal(runtime.nativePackage, undefined);
        assert.equal(runtime.vsceTarget, undefined);
        assert.ok(runtime.displayName.startsWith('Unsupported'));
    }
});

test('supported targets match the runtime selector', () => {
    assert.deepEqual(supportedRuntimeTargets(), [
        'darwin-arm64',
        'darwin-x64',
        'win32-arm64',
        'win32-x64',
        'linux-arm64',
        'linux-x64'
    ]);
});
