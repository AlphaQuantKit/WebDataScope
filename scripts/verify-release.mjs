import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
const releaseNotes = await readFile(new URL('../RELEASE_NOTES.md', import.meta.url), 'utf8');
const background = await readFile(new URL('../src/background/background.js', import.meta.url), 'utf8');
const telemetry = await readFile(new URL('../src/background/services/telemetryService.js', import.meta.url), 'utf8');
const sidebar = await readFile(new URL('../src/ui/sidebar/sidebar.html', import.meta.url), 'utf8');

const changelog = await decodeModule('../src/ui/sidebar/modules/changelogData.js');
const guide = await decodeModule('../src/ui/sidebar/modules/guideData.js');
const acknowledgements = await decodeModule('../src/ui/sidebar/modules/acknowledgementsData.js');

assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
assert.equal(manifest.update_url, undefined, 'Extension must not gain automatic updates without a new consent design.');
assert.equal(changelog[0]?.version, manifest.version, 'Changelog first entry must match manifest version.');
assert.ok(Array.isArray(acknowledgements.items), 'Acknowledgements must contain an items array.');
assert.ok(acknowledgements.items[0]?.name, 'Acknowledgements first item must have a name.');
assert.match(acknowledgements.items[0]?.href || '', /^https:\/\//);
assert.match(guide.title || '', new RegExp(`v${escapeRegex(manifest.version)}`, 'i'));
assert.match(releaseNotes, new RegExp(`Release version ${escapeRegex(manifest.version)}`));
assert.match(releaseNotes, /版本号遵循 x\.y\.z/);
assert.match(background, /import \{ initTelemetryService \} from '\.\/services\/telemetryService\.js';/);
assert.doesNotMatch(telemetry, /import\s*\(/, 'MV3 service worker must not use dynamic import().');
assert.match(telemetry, /credentials:\s*'omit'/);
assert.doesNotMatch(telemetry, /chrome\.cookies/);
assert.ok(
    sidebar.indexOf('id="acknowledgementsBox"') < sidebar.indexOf('id="changelogBox"'),
    'Acknowledgements must appear above the changelog.',
);

const privacySection = guide.sections?.find((section) => String(section.title).includes('版本登记'));
assert.ok(privacySection, 'Guide must include the version-registration privacy section.');
const privacyText = JSON.stringify(privacySection);
for (const required of ['WQ ID', '国家/地区', '随机安装 ID', '长期保存', '删除', 'credentials: omit']) {
    assert.ok(privacyText.includes(required), `Privacy guide is missing: ${required}`);
}

console.log(`Release verification passed for ${manifest.version}.`);

async function decodeModule(relativePath) {
    const source = await readFile(new URL(relativePath, import.meta.url), 'utf8');
    const chunks = Array.from(source.matchAll(/'([^']*)'/g), (match) => match[1]);
    assert.ok(chunks.length > 0, `No Base64 chunks found in ${relativePath}.`);
    return JSON.parse(Buffer.from(chunks.join(''), 'base64').toString('utf8'));
}

function escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
