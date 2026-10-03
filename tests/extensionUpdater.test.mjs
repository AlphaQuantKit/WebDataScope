import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const require = createRequire(import.meta.url);
const JSZip = require('../src/vendor/js/jszip.min.js');
const updaterPath = fileURLToPath(new URL('../scripts/update-extension.ps1', import.meta.url));
const powershellPath = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const windowsOnly = { skip: process.platform !== 'win32' };
const gitAvailable = spawnSync('git', ['--version'], { windowsHide: true }).status === 0;
const gitOnly = { skip: process.platform !== 'win32' || !gitAvailable };
const fixtureManifest = (version) => ({
    name: 'WorldQuant Scope', manifest_version: 3, version,
    background: { service_worker: 'src/background/background.js' },
    side_panel: { default_path: 'src/ui/sidebar/sidebar.html' },
    content_scripts: [{ js: ['src/content/new-content.js'] }],
});
const releaseFiles = {
    'manifest.json': JSON.stringify(fixtureManifest('2.0.0')),
    'src/background/background.js': 'new background',
    'src/ui/sidebar/sidebar.html': 'new sidebar',
    'src/shared/dataStore.js': 'new data store',
    'src/content/new-content.js': 'new content script',
    'img/logo.png': 'new icon',
    'README.md': 'new readme',
    'src/a-new.js': 'newly added file',
};

async function createFixture(t, overrides = {}) {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'WebDataScope-updater-test-'));
    t.after(async () => {
        const checkedRoot = path.resolve(temporaryRoot);
        assert.equal(path.dirname(checkedRoot), path.resolve(os.tmpdir()));
        assert.ok(path.basename(checkedRoot).startsWith('WebDataScope-updater-test-'));
        await rm(checkedRoot, { recursive: true, force: true });
    });
    const install = path.join(temporaryRoot, '原插件目录 with spaces');
    await mkdir(install);
    const oldFiles = {
        'manifest.json': JSON.stringify(fixtureManifest('1.0.0')),
        'src/background/background.js': 'old background',
        'src/shared/dataStore.js': 'old data store',
        'src/ui/sidebar/sidebar.html': 'old sidebar',
        'img/logo.png': 'old icon',
        'README.md': 'old readme',
        'data/imported-data.bin': 'user imported data',
        'settings-backup.json': 'user settings backup',
        'src/custom-notes.txt': 'user custom note',
    };
    for (const [relative, contents] of Object.entries(oldFiles)) {
        const target = path.join(install, relative);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, contents);
    }
    const archive = path.join(temporaryRoot, 'release.zip');
    const zip = new JSZip();
    for (const [relative, contents] of Object.entries({ ...releaseFiles, ...overrides })) {
        if (contents !== null) zip.file(`WebDataScope-2.0.0/${relative}`, contents);
    }
    await writeFile(archive, await zip.generateAsync({ type: 'nodebuffer' }));
    return { temporaryRoot, install, archive, oldFiles };
}

function update(fixture, extraArgs = [], options = {}) {
    return spawnSync(powershellPath, [
        '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', updaterPath,
        '-InstallDirectory', fixture.install, '-ArchivePath', fixture.archive, ...extraArgs,
    ], { encoding: 'utf8', timeout: 60000, windowsHide: true, ...options });
}

async function directoryHashes(root) {
    const hashes = {};
    async function visit(directory, relative = '') {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            const nextRelative = path.posix.join(relative, entry.name);
            const fullPath = path.join(directory, entry.name);
            if (entry.isDirectory()) await visit(fullPath, nextRelative);
            else if (entry.isSymbolicLink()) hashes[nextRelative] = '<link>';
            else hashes[nextRelative] = createHash('sha256').update(await readFile(fullPath)).digest('hex');
        }
    }
    await visit(root);
    return hashes;
}

async function worktreeHashes(root) {
    const hashes = await directoryHashes(root);
    return Object.fromEntries(Object.entries(hashes).filter(([relative]) => !relative.startsWith('.git/')));
}

function initializeGit(fixture) {
    for (const args of [
        ['init', '--quiet'], ['add', '.'],
        ['-c', 'user.name=Updater test', '-c', 'user.email=updater-test@example.invalid', 'commit', '--quiet', '-m', 'Test fixture'],
    ]) {
        const result = spawnSync('git', args, { cwd: fixture.install, encoding: 'utf8', windowsHide: true });
        assert.equal(result.status, 0, result.stdout + result.stderr);
    }
}

async function writeNextRelease(fixture, version) {
    const zip = new JSZip();
    for (const [relative, contents] of Object.entries({
        ...releaseFiles,
        'manifest.json': JSON.stringify(fixtureManifest(version)),
        'src/background/background.js': `background version ${version}`,
    })) zip.file(`WebDataScope-${version}/${relative}`, contents);
    await writeFile(fixture.archive, await zip.generateAsync({ type: 'nodebuffer' }));
}

test('the Windows updater works without Git, Node or Python on PATH and preserves user files in a Unicode directory', windowsOnly, async (t) => {
    const fixture = await createFixture(t);
    const result = update(fixture, [], { env: {
        ...process.env,
        PATH: [process.env.WINDIR, path.join(process.env.WINDIR, 'System32'), path.dirname(powershellPath)].join(';'),
    } });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    for (const [relative, contents] of Object.entries(releaseFiles)) {
        assert.equal(await readFile(path.join(fixture.install, relative), 'utf8'), contents, relative);
    }
    for (const relative of ['data/imported-data.bin', 'settings-backup.json', 'src/custom-notes.txt']) {
        assert.equal(await readFile(path.join(fixture.install, relative), 'utf8'), fixture.oldFiles[relative]);
    }
    assert.match(result.stdout, /chrome:\/\/extensions 或 edge:\/\/extensions/);
});

test('checking an offline release makes no changes', windowsOnly, async (t) => {
    const fixture = await createFixture(t);
    const before = await directoryHashes(fixture.install);
    const result = update(fixture, ['-CheckOnly']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /更新检查通过：1\.0\.0 → 2\.0\.0/);
    assert.deepEqual(await directoryHashes(fixture.install), before);
});

test('the BAT launcher finds its PowerShell script in a Unicode directory without Git on PATH', windowsOnly, async (t) => {
    const fixture = await createFixture(t);
    await mkdir(path.join(fixture.install, 'scripts'));
    await writeFile(path.join(fixture.install, 'scripts/update-extension.ps1'), await readFile(updaterPath));
    const batPath = path.join(fixture.install, 'update.bat');
    await writeFile(batPath, await readFile(new URL('../update.bat', import.meta.url)));
    const result = spawnSync(path.join(process.env.WINDIR, 'System32', 'cmd.exe'), [
        '/d', '/s', '/c', `""${batPath}" -ArchivePath "${fixture.archive}""`,
    ], {
        encoding: 'utf8', timeout: 60000, windowsHide: true, windowsVerbatimArguments: true, input: '\r\n',
        env: { ...process.env, PATH: [process.env.WINDIR, path.join(process.env.WINDIR, 'System32'), path.dirname(powershellPath)].join(';') },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /WebDataScope 一键更新器/);
    assert.match(result.stdout, /已在原目录更新至 2\.0\.0/);
    assert.match(result.stdout, /按任意键关闭窗口/, result.stdout + result.stderr);
    assert.ok(!result.stdout.includes('\uFFFD'), 'Chinese prompts must decode correctly as UTF-8.');
    assert.equal(result.stderr, '', 'The BAT launcher must not produce command parsing errors.');
    assert.equal(JSON.parse(await readFile(path.join(fixture.install, 'manifest.json'), 'utf8')).version, '2.0.0');
});

test('a ZIP missing a required content script is rejected before changing any files', windowsOnly, async (t) => {
    const fixture = await createFixture(t, { 'src/content/new-content.js': null });
    const before = await directoryHashes(fixture.install);
    const result = update(fixture);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /发行版压缩包缺少必需的插件文件/);
    assert.deepEqual(await directoryHashes(fixture.install), before);
});

test('invalid ZIP errors remain Chinese regardless of the Windows display language', windowsOnly, async (t) => {
    const fixture = await createFixture(t);
    await writeFile(fixture.archive, 'not a valid ZIP archive');
    const before = await directoryHashes(fixture.install);
    const result = update(fixture);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /更新失败：压缩包损坏或格式无效，请重新下载。/);
    assert.equal(result.stderr, '');
    assert.deepEqual(await directoryHashes(fixture.install), before);
});

test('ZIP path traversal is rejected before changing any files', windowsOnly, async (t) => {
    const fixture = await createFixture(t, { '../../escape.txt': 'must never be extracted' });
    const before = await directoryHashes(fixture.install);
    const result = update(fixture);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /压缩包中含有不安全的路径/);
    assert.deepEqual(await directoryHashes(fixture.install), before);
});

test('Git checkouts can update while preserving unrelated uncommitted files', gitOnly, async (t) => {
    const fixture = await createFixture(t);
    initializeGit(fixture);
    await mkdir(path.join(fixture.install, 'pnl-share-worker'));
    const workerFile = path.join(fixture.install, 'pnl-share-worker/uncommitted.txt');
    await writeFile(workerFile, 'keep unrelated work');
    const gitHead = await readFile(path.join(fixture.install, '.git/HEAD'), 'utf8');
    const result = update(fixture);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(await readFile(workerFile, 'utf8'), 'keep unrelated work');
    assert.equal(await readFile(path.join(fixture.install, '.git/HEAD'), 'utf8'), gitHead);
    assert.equal(JSON.parse(await readFile(path.join(fixture.install, 'manifest.json'), 'utf8')).version, '2.0.0');
});

test('uncommitted local runtime edits are protected before updating a Git checkout', gitOnly, async (t) => {
    const fixture = await createFixture(t);
    initializeGit(fixture);
    await writeFile(path.join(fixture.install, 'src/background/background.js'), 'uncommitted local code');
    const before = await worktreeHashes(fixture.install);
    const result = update(fixture);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /更新会覆盖本地修改：src\/background\/background\.js/);
    assert.deepEqual(await worktreeHashes(fixture.install), before);
});

test('a Git checkout can update repeatedly without treating the previous update as local edits', gitOnly, async (t) => {
    const fixture = await createFixture(t);
    initializeGit(fixture);
    const first = update(fixture);
    assert.equal(first.status, 0, first.stdout + first.stderr);
    await writeNextRelease(fixture, '3.0.0');
    const second = update(fixture);
    assert.equal(second.status, 0, second.stdout + second.stderr);
    assert.equal(await readFile(path.join(fixture.install, 'src/background/background.js'), 'utf8'), 'background version 3.0.0');
    assert.equal(JSON.parse(await readFile(path.join(fixture.install, 'manifest.json'), 'utf8')).version, '3.0.0');
});

test('a directory containing Git metadata updates without Git on PATH and keeps a recovery backup', windowsOnly, async (t) => {
    const fixture = await createFixture(t);
    await mkdir(path.join(fixture.install, '.git'));
    const result = update(fixture, [], { env: {
        ...process.env,
        PATH: [process.env.WINDIR, path.join(process.env.WINDIR, 'System32'), path.dirname(powershellPath)].join(';'),
    } });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const backupMatch = result.stdout.match(/已保留此目录的恢复备份：([^\r\n]+)/);
    assert.ok(backupMatch, result.stdout);
    const backupRoot = path.resolve(backupMatch[1]);
    assert.equal(path.dirname(backupRoot), path.resolve(os.tmpdir()));
    assert.match(path.basename(backupRoot), /^WebDataScope-update-[a-f0-9]{32}$/);
    t.after(async () => { await rm(backupRoot, { recursive: true, force: true }); });
    assert.equal(await readFile(path.join(backupRoot, 'backup/src/background/background.js'), 'utf8'), 'old background');
    assert.equal(JSON.parse(await readFile(path.join(fixture.install, 'manifest.json'), 'utf8')).version, '2.0.0');
});

test('file hashes protect edits made after an update even without Git metadata', windowsOnly, async (t) => {
    const fixture = await createFixture(t);
    const first = update(fixture);
    assert.equal(first.status, 0, first.stdout + first.stderr);
    await writeFile(path.join(fixture.install, 'src/background/background.js'), 'local code after an update');
    await writeNextRelease(fixture, '3.0.0');
    const before = await directoryHashes(fixture.install);
    const second = update(fixture);
    assert.equal(second.status, 1, second.stdout + second.stderr);
    assert.match(second.stdout, /更新会覆盖本地修改/);
    assert.deepEqual(await directoryHashes(fixture.install), before);
});

test('existing directory junctions cannot redirect the update outside the installation', windowsOnly, async (t) => {
    const fixture = await createFixture(t);
    const outside = path.join(fixture.temporaryRoot, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'do-not-change.txt'), 'outside sentinel');
    await symlink(outside, path.join(fixture.install, 'src/content'), 'junction');
    const before = await directoryHashes(fixture.install);
    const result = update(fixture);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /符号链接或目录联接/);
    assert.deepEqual(await directoryHashes(fixture.install), before);
    assert.deepEqual(await readdir(outside), ['do-not-change.txt']);
});

test('an identical or older release is a no-op', windowsOnly, async (t) => {
    const fixture = await createFixture(t);
    await writeFile(path.join(fixture.install, 'manifest.json'), JSON.stringify(fixtureManifest('3.0.0')));
    const before = await directoryHashes(fixture.install);
    const result = update(fixture);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(await directoryHashes(fixture.install), before);
});

test('a failed overwrite restores old files and removes newly added files', windowsOnly, async (t) => {
    const fixture = await createFixture(t);
    const before = await directoryHashes(fixture.install);
    const command = `
        $global:WDS_TEST_FAILURE_INJECTED = $false
        function Copy-Item {
            param([string]$LiteralPath, [string]$Destination, [switch]$Force)
            if (-not $global:WDS_TEST_FAILURE_INJECTED -and $Destination -eq $env:WDS_TEST_FAIL_DEST) {
                $global:WDS_TEST_FAILURE_INJECTED = $true
                [IO.File]::WriteAllText($Destination, 'partial write')
                throw 'Injected write failure'
            }
            Microsoft.PowerShell.Management\\Copy-Item @PSBoundParameters
        }
        & $env:WDS_TEST_UPDATER -InstallDirectory $env:WDS_TEST_INSTALL -ArchivePath $env:WDS_TEST_ARCHIVE
        exit $LASTEXITCODE
    `;
    const result = spawnSync(powershellPath, ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
        encoding: 'utf8', timeout: 60000, windowsHide: true,
        env: {
            ...process.env,
            WDS_TEST_UPDATER: updaterPath,
            WDS_TEST_INSTALL: fixture.install,
            WDS_TEST_ARCHIVE: fixture.archive,
            WDS_TEST_FAIL_DEST: path.join(fixture.install, 'src/shared/dataStore.js'),
        },
    });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /已恢复原来的插件文件/);
    assert.deepEqual(await directoryHashes(fixture.install), before);
});
