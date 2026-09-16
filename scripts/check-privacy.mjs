import { execFileSync } from 'node:child_process';
import { isIP } from 'node:net';

// 检查即将提交的索引；命中只输出位置和规则，避免审计日志再次泄漏。
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split(String.fromCharCode(0)).filter(Boolean);
const publicHosts = new Set([
  'github.com', 'developer.android.google.cn', 'schemas.android.com', 'www.w3.org',
  'registry.npmjs.org', 'registry.npmmirror.com', 'services.gradle.org',
  'dotenvx.com', 'feross.org', 'opencollective.com', 'paulmillr.com',
  'tidelift.com', 'www.npmjs.com', 'www.patreon.com',
]);
const exampleHost = host => ['localhost', '127.0.0.1', '[::1]', '::1'].includes(host) ||
  /(^|[.])example[.](com|net|org)$/.test(host) || /(^|[.])(example|test|invalid)$/.test(host);
const rules = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['access-token', /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}|sk-(?:proj-)?[A-Za-z0-9_-]{32,})/],
  ['personal-path', /[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/](?!Public)[A-Za-z0-9_.-]+/],
  ['personal-home', /[/](?:home|Users)[/](?!example)[A-Za-z0-9_.-]+/],
];
const errors = [];
for (const file of files) {
  if ((/(?:^|[/])(?:[.]env(?:[.].+)?|android-release[.]properties)$/.test(file) && !file.endsWith('.example')) ||
      /[.](?:pem|key|jks|keystore|p12|pfx|sqlite|apk|exe)$/.test(file) || /[.]local[.](?:json|ps1)$/.test(file)) {
    errors.push(file + ': private-file');
  }
  const bytes = execFileSync('git', ['show', ':' + file], { maxBuffer: 16 * 1024 * 1024 });
  if (bytes.includes(0)) continue; // 二进制图片和图标需另行人工审查。
  bytes.toString('utf8').split(String.fromCharCode(10)).forEach((line, index) => {
    const report = rule => errors.push(file + ':' + (index + 1) + ': ' + rule);
    for (const [name, pattern] of rules) if (pattern.test(line)) report(name);
    for (const match of line.matchAll(/https?:[/][/][A-Za-z0-9.:-]+/g)) {
      let host;
      try { host = new URL(match[0]).hostname; } catch { continue; }
      if (!exampleHost(host) && !publicHosts.has(host)) report('non-example-host');
    }
    for (const match of line.matchAll(/(?:[0-9]{1,3}[.]){3}[0-9]{1,3}/g)) {
      if (isIP(match[0]) && !['127.0.0.1', '0.0.0.0'].includes(match[0]) &&
          !/^(192[.]0[.]2|198[.]51[.]100|203[.]0[.]113)[.]/.test(match[0])) report('non-example-ip');
    }
    for (const match of line.matchAll(/[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+[.][A-Za-z]{2,})/g)) {
      if (!exampleHost(match[1])) report('personal-email');
    }
  });
}
if (errors.length) {
  console.error([...new Set(errors)].join(String.fromCharCode(10)));
  process.exit(1);
}
console.log('privacy: ' + files.length + ' indexed files checked; binary assets and unknown secret formats require manual review');
