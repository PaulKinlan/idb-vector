// Least privilege for every workflow that installs dependencies (idb-vector-nkay). `npm ci` runs
// third-party install scripts, so the job that runs it must not hold token rights it never uses.
// pages.yml pins that for the Pages publication in pages-workflow-permissions.test.mjs; this suite is
// the repo-wide floor behind it: every workflow declares explicit permissions no wider than
// `contents: read`, no job that installs dependencies holds more than that, and any grant above the
// floor lives on a named job with its reason. Without a declared block a job runs with the repository
// or organisation default - often write-all - which nothing in this repo pins down.
//
// The Node-major parity rule below discovers its own subjects: a workflow counts as publish or deploy
// when a step publishes a package or deploys the site, so a publish path added tomorrow is pinned to a
// Node major without anyone remembering to add it to a list (idb-vector-koec).
//
// Text-level on purpose: the fast tier has no YAML parser and this must cost nothing.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

const workflowsDir = new URL('../../.github/workflows/', import.meta.url);
const workflowFiles = readdirSync(workflowsDir)
  .filter(name => /\.ya?ml$/.test(name))
  .sort();

// Everything above `jobs:` is the workflow-level scope every job inherits; a job key is a two-space
// indented `name:` line inside the jobs block and everything deeper belongs to that job.
function splitWorkflow(yaml) {
  const lines = yaml.split('\n');
  const jobsAt = lines.findIndex(line => /^jobs:\s*$/.test(line));
  assert.notEqual(jobsAt, -1, 'a workflow must declare a jobs: block');
  const jobs = new Map();
  let current = null;
  for (const line of lines.slice(jobsAt + 1)) {
    const key = /^ {2}([A-Za-z][\w-]*):\s*$/.exec(line);
    if (key) {
      current = { name: key[1], lines: [] };
      jobs.set(current.name, current.lines);
    } else if (current && line.trim() !== '') {
      current.lines.push(line);
    }
  }
  return {
    scope: lines.slice(0, jobsAt).join('\n'),
    jobs: new Map([...jobs].map(([name, body]) => [name, body.join('\n')])),
  };
}

// Strip #-to-end-of-line comments from text while preserving '#' inside single or double quotes.
// Limitation: does not parse multiline quoted strings or YAML block scalars spanning across lines.
function withoutComments(text) {
  return text
    .split('\n')
    .filter(line => !line.trim().startsWith('#'))
    .map(line => {
      let inSingleQuote = false;
      let inDoubleQuote = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '\\' && inDoubleQuote && i + 1 < line.length) {
          i++;
          continue;
        }
        if (ch === "'" && !inDoubleQuote) {
          inSingleQuote = !inSingleQuote;
        } else if (ch === '"' && !inSingleQuote) {
          inDoubleQuote = !inDoubleQuote;
        } else if (ch === '#' && !inSingleQuote && !inDoubleQuote) {
          return line.slice(0, i);
        }
      }
      return line;
    })
    .join('\n');
}

// Steps in a job body under `steps:`. A step begins with `      - ` (6 spaces and a dash).
function extractSteps(jobBody) {
  const lines = jobBody.split('\n');
  const stepsAt = lines.findIndex(line => /^ {4}steps:\s*$/.test(line));
  if (stepsAt === -1) return [];
  const steps = [];
  let current = null;
  for (let i = stepsAt + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^ {0,4}\S/.test(line)) break;
    const stepMarker = /^ {6}-\s*(.*)$/.exec(line);
    if (stepMarker) {
      if (current) steps.push(current);
      current = { lines: [stepMarker[1].trim()].filter(Boolean) };
    } else if (current) {
      current.lines.push(line.trim());
    }
  }
  if (current) steps.push(current);
  return steps.map((s, idx) => {
    const text = s.lines.join('\n');
    const code = withoutComments(text);
    const nameLine = s.lines.find(l => /^name:\s*(.+)$/.test(l));
    const runLine = s.lines.find(l => /^run:\s*(.+)$/.test(l));
    const usesLine = s.lines.find(l => /^uses:\s*(.+)$/.test(l));
    const stepName = nameLine
      ? /^name:\s*(.+)$/.exec(nameLine)[1].trim()
      : runLine
        ? /^run:\s*(.+)$/.exec(runLine)[1].trim()
        : usesLine
          ? /^uses:\s*(.+)$/.exec(usesLine)[1].trim()
          : `step ${idx + 1}`;
    return {
      index: idx + 1,
      name: stepName,
      text,
      code,
    };
  });
}

// Extract node-version declarations from un-commented text.
function extractAllNodeVersions(text) {
  const matches = [...withoutComments(text).matchAll(/\bnode-version:\s*['"]?([^'"\s\n]+)['"]?/g)];
  return matches.map(m => {
    const raw = m[1];
    const majorMatch = /^(\d+)/.exec(raw);
    return {
      raw,
      major: majorMatch ? parseInt(majorMatch[1], 10) : null,
    };
  });
}

// Extract actions/setup-node steps and their configured node-version from a job body.
function extractSetupNodeVersions(jobBody) {
  const steps = extractSteps(jobBody);
  const results = [];
  for (const step of steps) {
    if (/\buses:\s*actions\/setup-node@/i.test(step.code)) {
      const versionMatch = /\bnode-version:\s*['"]?([^'"\s\n]+)['"]?/.exec(step.code);
      const rawVersion = versionMatch ? versionMatch[1] : null;
      const majorMatch = rawVersion ? /^(\d+)/.exec(rawVersion) : null;
      const major = majorMatch ? parseInt(majorMatch[1], 10) : null;
      results.push({
        stepIndex: step.index,
        stepName: step.name,
        rawVersion,
        major,
      });
    }
  }
  return results;
}

// The `permissions:` key at exactly `indent` spaces, either inline (`permissions: {contents: read}`) or
// as a block of `name: level` lines one level deeper. `null` means the key is absent at that level, so
// the job inherits whatever the level above grants, and at the workflow level that is the repository
// default rather than anything this repo chose.
function permissionsAt(scope, indent, where) {
  const lines = scope.split('\n');
  const key = new RegExp(`^ {${indent}}permissions:(.*)$`);
  const at = lines.findIndex(line => key.test(line));
  if (at === -1) return null;
  const inline = key.exec(lines[at])[1].replace(/#.*/, '').trim();
  if (inline !== '') {
    const body = inline.replace(/^\{/, '').replace(/\}$/, '').trim();
    if (body === '') return new Map();
    // `permissions: write-all` / `read-all` are broader than any named grant; keep them readable as one
    // entry so a test can say what they do to the floor.
    if (body === 'write-all' || body === 'read-all') return new Map([[body, 'all']]);
    return new Map(body.split(',').map(pair => {
      const [name, level] = pair.split(':').map(part => part.trim());
      assert.ok(name && level, `${where} has an unreadable inline permission entry: "${pair.trim()}"`);
      return [name, level];
    }));
  }
  const grants = new Map();
  const grant = new RegExp(`^ {${indent + 2}}([a-z-]+):\\s*(\\S+)\\s*$`);
  for (const line of lines.slice(at + 1)) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const match = grant.exec(line);
    if (!match) break; // dedent out of the block, or the next top-level key
    grants.set(match[1], match[2]);
  }
  return grants;
}

const workflows = workflowFiles.map(file => {
  const yaml = readFileSync(new URL(file, workflowsDir), 'utf8');
  const { scope, jobs } = splitWorkflow(yaml);
  return {
    file,
    scope,
    workflowScope: permissionsAt(scope, 0, `${file} (workflow level)`),
    jobs: [...jobs].map(([name, body]) => {
      const declared = permissionsAt(body, 4, `${file} job "${name}"`);
      return { name, body, declared, effective: declared ?? permissionsAt(scope, 0, `${file} (workflow level)`) };
    }),
  };
});

const formatGrants = grants => [...grants].map(([name, level]) => (level === 'all' ? name : `${name}: ${level}`)).join(', ');

// The floor every job may hold. `contents: read` is what checkout needs to read the commit; nothing
// here needs to write it.
const floor = new Map([['contents', 'read']]);
const floorEntries = [...floor];

// The only grants any job in this repo may hold above the floor, keyed `workflow:job`, each with the
// reason it is required. Reaching for a new one is the review point: the entry has to say what the job
// does with it. The publish job is deliberately absent - `npm publish` authenticates to
// registry.npmjs.org with NODE_AUTH_TOKEN (secrets.NPM_TOKEN, a token outside GitHub), so it uses no
// GITHUB_TOKEN scope at all and `packages: write` would only be needed for a GitHub Packages registry.
const justifiedGrants = {
  'pages.yml:deploy': {
    pages: { level: 'write', why: 'actions/deploy-pages publishes the built artifact through the Pages API' },
    'id-token': { level: 'write', why: 'actions/deploy-pages mints the Pages OIDC token it deploys with' },
  },
};

// The jobs that install dependencies today, pinned so that dropping one of them out of the scan below
// (a renamed command, a switched package manager) is a failure rather than a silent gap.
const installJobs = [
  'npm-publish-github-packages.yml:build',
  'packed-stress.yml:stress',
  'pages.yml:build',
];

// The jobs that reference NODE_AUTH_TOKEN today. Every npm ci step in these jobs must carry
// --ignore-scripts so dependency lifecycle scripts cannot run in an environment that carries
// publish credentials (idb-vector-4r86). Pinning the list ensures that a new publish or credential-
// bearing job is reviewed here, and an existing one cannot be silently renamed or dropped.
const tokenPublishJobs = [
  'npm-publish-github-packages.yml:build',
];

// The workflows that publish packages or deploy site artifacts. Every workflow that publishes or
// deploys must use the same Node major as its siblings (Node 22), and no workflow across the repo
// may use an abandoned Node version (idb-vector-pw5j).
const publishOrDeployWorkflows = [
  'npm-publish-github-packages.yml',
  'pages.yml',
];

// The supported Node major across the repository CI/CD pipeline. Node versions prior to 22
// (e.g. Node 16 EOL 2023-09-11) are abandoned and must not be used by any workflow (idb-vector-pw5j).
const EXPECTED_NODE_MAJOR = 22;

// What makes a workflow a publish or deploy workflow, matched against each step's un-commented text.
// Discovery is the point here (idb-vector-koec): the list above can only cover workflows someone
// remembered to add to it, so a publish path added later would run on whatever Node the runner image
// happens to default to, and nothing would say so.
const publishOrDeployMarkers = [
  // `npm publish` and its package-manager siblings send a package to a registry.
  /\b(?:npm|pnpm|yarn)\s+publish\b/,
  // `npm pack` alone only writes a tarball; it publishes only when the same run pipes it into a publish.
  /\bnpm\s+pack\b[^\n]*\|\s*(?:npm|pnpm|yarn)\s+publish\b/,
  // `gh-pages` pushes a directory or a branch to the Pages site.
  /\bgh-pages\b/,
  // The Pages pair: the build job uploads the artifact, the deploy job publishes it.
  /\bupload-pages-artifact\b/,
  /\bdeploy-pages\b/,
  // A publish action, e.g. JS-DevTools/npm-publish@v3 or pypa/gh-action-pypi-publish@release/v1.
  /\buses:\s*[^\s@]*publish[^\s@]*@/i,
];

// Why this workflow publishes or deploys, or null when nothing in it does. The reason names the step
// that matched, so a newly discovered publish path fails with the line that made it one.
function publishOrDeployReason(workflow) {
  for (const job of workflow.jobs) {
    for (const step of extractSteps(job.body)) {
      const marker = publishOrDeployMarkers.find(candidate => candidate.test(step.code));
      if (marker) return `job "${job.name}" step ${step.index} ("${step.name}") matches ${marker}`;
    }
  }
  return null;
}

const discoveredPublishOrDeploy = workflows
  .map(workflow => ({ file: workflow.file, workflow, why: publishOrDeployReason(workflow) }))
  .filter(entry => entry.why !== null);

// A discovered publish or deploy workflow may inherit the runner's Node only if it is listed here with
// the reason it cannot pin a major. Prefer an empty list: the runner image's default Node changes
// without a commit here, so an unpinned publish path can change major under the same workflow file.
const inheritsRunnerNode = {
  // none today
};

test('every workflow declares workflow-level permissions no wider than contents: read', () => {
  assert.ok(workflows.length > 0, 'the scan must actually read .github/workflows');
  for (const { file, workflowScope } of workflows) {
    assert.notEqual(workflowScope, null, `"${file}" declares no permissions: block, so every job in it runs with the repository or organisation default; declare contents: read on the workflow`);
    assert.ok(workflowScope.size > 0, `"${file}" resolves to an empty permissions block; declare contents: read on the workflow`);
    assert.deepEqual(
      [...workflowScope],
      floorEntries,
      `"${file}" grants ${formatGrants(workflowScope)} at the workflow level, which every job inherits; the workflow-level scope is exactly contents: read, and anything wider belongs on one named job`,
    );
  }
});

test('no job that installs dependencies holds more than contents: read', () => {
  const installing = [];
  for (const { file, jobs } of workflows) {
    for (const job of jobs) {
      if (/\bnpm\s+(ci|install)\b/.test(job.body)) installing.push({ file, ...job });
    }
  }
  assert.deepEqual(
    installing.map(({ file, name }) => `${file}:${name}`).sort(),
    installJobs,
    'the set of jobs that install dependencies changed: a new one is reviewed here before it is added, and an install no longer visible to this scan is a gap, not a pass',
  );
  for (const { file, name, effective } of installing) {
    const where = `${file} job "${name}"`;
    assert.notEqual(effective, null, `${where} runs npm ci and declares no permissions at any level, so it runs with the repository or organisation default; declare contents: read`);
    assert.ok(effective.size > 0, `${where} runs npm ci and resolves to an empty permissions block; checkout still needs contents: read`);
    assert.deepEqual(
      [...effective],
      floorEntries,
      `${where} runs npm ci, which executes third-party install scripts, and holds ${formatGrants(effective)}; it may hold at most contents: read, and a publish or deploy credential belongs on a separate job or in a secret`,
    );
  }
});

test('every grant above the floor is a job that names its reason here', () => {
  for (const { file, jobs } of workflows) {
    for (const { name, effective } of jobs) {
      const above = [...(effective ?? new Map())].filter(([grant, level]) => floor.get(grant) !== level);
      const justified = justifiedGrants[`${file}:${name}`] ?? {};
      const declared = Object.entries(justified).map(([grant, { level }]) => [grant, level]);
      assert.deepEqual(
        above.sort(([a], [b]) => a.localeCompare(b)),
        declared.sort(([a], [b]) => a.localeCompare(b)),
        `${file} job "${name}" holds [${formatGrants(above)}] above the contents: read floor; list each grant with its level and reason in justifiedGrants, or drop it`,
      );
      for (const [grant, { why }] of Object.entries(justified)) {
        assert.match(why, /\S/, `${file} job "${name}": the justifiedGrants entry for ${grant} must say what the job does with it`);
      }
    }
  }
  for (const key of Object.keys(justifiedGrants)) {
    const [file, name] = key.split(':');
    const workflow = workflows.find(candidate => candidate.file === file);
    assert.ok(workflow, `justifiedGrants names ${file}, which is not a workflow here`);
    assert.ok(workflow.jobs.some(job => job.name === name), `justifiedGrants names job "${name}" in ${file}, which no longer exists; drop the entry so the grant is not carried forward`);
  }
});

test('every npm ci step in a job that references NODE_AUTH_TOKEN carries --ignore-scripts (idb-vector-4r86)', () => {
  const tokenHoldingJobs = [];
  for (const { file, jobs } of workflows) {
    for (const job of jobs) {
      if (/\bNODE_AUTH_TOKEN\b/.test(job.body)) {
        tokenHoldingJobs.push({ file, ...job });
      }
    }
  }

  assert.deepEqual(
    tokenHoldingJobs.map(({ file, name }) => `${file}:${name}`).sort(),
    tokenPublishJobs,
    'the set of jobs referencing NODE_AUTH_TOKEN changed: review any new credential-holding job here',
  );

  for (const { file, name, body } of tokenHoldingJobs) {
    const steps = extractSteps(body);
    const installSteps = steps.filter(step => /\bnpm\s+(ci|install)\b/.test(step.code));
    assert.ok(
      installSteps.length > 0,
      `${file} job "${name}" references NODE_AUTH_TOKEN but has no install step; verify publish dependencies`,
    );

    for (const step of installSteps) {
      assert.match(
        step.code,
        /(?:^|\s)--ignore-scripts(?:\s|$)/,
        `${file} job "${name}" step ${step.index} ("${step.name}"): npm ci must carry --ignore-scripts in a job that references NODE_AUTH_TOKEN`,
      );
    }
  }
});

// The publish token (NODE_AUTH_TOKEN / secrets.NPM_TOKEN) must not be exported more broadly than
// the publish step needs. Placing it in workflow-level or job-level `env:` would expose the token to
// every step in the job (including checkout and setup-node), so it is scoped strictly to `npm publish`.
test('publish tokens are scoped strictly to the publish step and not exported to the job or install environment', () => {
  for (const { file, scope, jobs } of workflows) {
    assert.doesNotMatch(
      withoutComments(scope),
      /\b(NODE_AUTH_TOKEN|secrets\.NPM_TOKEN)\b/,
      `"${file}" must not export publish credentials at the workflow level; scope credentials to individual steps`,
    );

    for (const { name, body } of jobs) {
      if (!tokenPublishJobs.includes(`${file}:${name}`)) {
        assert.doesNotMatch(
          withoutComments(body),
          /\b(NODE_AUTH_TOKEN|secrets\.NPM_TOKEN)\b/,
          `"${file}" job "${name}" is not a recognized publish job and must not reference publish credentials`,
        );
        continue;
      }

      // Inside a token-bearing job:
      // 1. Job-level env (before steps:) must not define NODE_AUTH_TOKEN or secrets.NPM_TOKEN
      const stepsAt = body.search(/^ {4}steps:\s*$/m);
      const preSteps = stepsAt === -1 ? body : body.slice(0, stepsAt);
      assert.doesNotMatch(
        withoutComments(preSteps),
        /\b(NODE_AUTH_TOKEN|secrets\.NPM_TOKEN)\b/,
        `"${file}" job "${name}" must not declare publish credentials in job-level env; publish credentials belong only on the publish step`,
      );

      // 2. Only the publish step may reference NODE_AUTH_TOKEN
      const steps = extractSteps(body);
      for (const step of steps) {
        const isPublishStep = /\bnpm publish\b/.test(step.code);
        if (!isPublishStep) {
          assert.doesNotMatch(
            step.code,
            /\b(NODE_AUTH_TOKEN|secrets\.NPM_TOKEN)\b/,
            `"${file}" job "${name}" step ${step.index} ("${step.name}") must not have publish credentials in env; only npm publish needs NODE_AUTH_TOKEN`,
          );
        } else {
          assert.match(
            step.code,
            /\bNODE_AUTH_TOKEN:\s*\${{\s*secrets\.NPM_TOKEN\s*}}/,
            `"${file}" job "${name}" step ${step.index} ("${step.name}") must provide NODE_AUTH_TOKEN from secrets.NPM_TOKEN to npm publish`,
          );
        }
      }
    }
  }
});

test('every workflow that publishes or deploys uses the same Node major as its siblings, and no workflow uses an abandoned Node version', () => {
  // The enumerated list, held to the tree: this is the fallback check, and the discovery below is the
  // one that does not depend on anyone remembering to extend the list.
  const enumeratedPresentInTree = workflows
    .map(w => w.file)
    .filter(file => publishOrDeployWorkflows.includes(file));
  assert.deepEqual(
    enumeratedPresentInTree.sort(),
    publishOrDeployWorkflows.slice().sort(),
    'all publish or deploy workflows must be present in .github/workflows',
  );

  // The enumerated list is the fallback for these files, not their only record: if the discovery below
  // stopped seeing one of them publish or deploy, a new publish step in that file would be invisible to
  // both checks (idb-vector-koec).
  assert.deepEqual(
    publishOrDeployWorkflows.filter(file => !discoveredPublishOrDeploy.some(entry => entry.file === file)),
    [],
    'publishOrDeployWorkflows names a workflow that no longer publishes or deploys as far as discovery can see; drop the entry or fix the matcher, so a publish step in that file is still pinned',
  );

  for (const { file, scope, jobs } of workflows) {
    const isPublishOrDeploy = publishOrDeployWorkflows.includes(file);

    const workflowNodeMatches = extractAllNodeVersions(scope);
    assert.equal(
      workflowNodeMatches.length,
      0,
      `"${file}" declares node-version at workflow level; configure node-version in job steps`,
    );

    let foundNodeSetup = false;
    for (const { name, body } of jobs) {
      const setups = extractSetupNodeVersions(body);
      for (const setup of setups) {
        foundNodeSetup = true;
        assert.ok(
          setup.rawVersion,
          `"${file}" job "${name}" step ${setup.stepIndex} ("${setup.stepName}") uses actions/setup-node without specifying node-version`,
        );
        assert.equal(
          setup.major,
          EXPECTED_NODE_MAJOR,
          `"${file}" job "${name}" uses offending node-version "${setup.rawVersion}"; every workflow that publishes or deploys must use Node major ${EXPECTED_NODE_MAJOR} and abandoned Node versions are not permitted`,
        );
      }

      const allNodeMatches = extractAllNodeVersions(body);
      for (const match of allNodeMatches) {
        assert.equal(
          match.major,
          EXPECTED_NODE_MAJOR,
          `"${file}" job "${name}" uses offending node-version "${match.raw}"; every workflow that publishes or deploys must use Node major ${EXPECTED_NODE_MAJOR} and abandoned Node versions are not permitted`,
        );
      }
    }

    if (isPublishOrDeploy) {
      assert.ok(
        foundNodeSetup,
        `"${file}" is a publish or deploy workflow but does not configure Node; it must use Node major ${EXPECTED_NODE_MAJOR}`,
      );
    }
  }
});

// The version rule the list above applies, applied to whatever the tree contains (idb-vector-koec). A
// publish or deploy workflow that runs on the runner's default Node publishes an artifact whose Node
// major nobody chose and no test names; requiring the declaration is what makes the parity rule reach
// a publish path added after this file was written.
test('every workflow discovered publishing or deploying declares an explicit node-version (idb-vector-koec)', () => {
  assert.ok(
    discoveredPublishOrDeploy.length > 0,
    'the publish and deploy discovery found no workflow at all, so it is not pinning the Node major of any publish path',
  );

  for (const { file, workflow, why } of discoveredPublishOrDeploy) {
    if (inheritsRunnerNode[file] !== undefined) continue;
    const pinned = workflow.jobs.flatMap(job => extractSetupNodeVersions(job.body)).filter(setup => setup.rawVersion);
    assert.ok(
      pinned.length > 0,
      `"${file}" publishes or deploys (${why}) but no actions/setup-node step declares a node-version, so it runs on whatever Node the runner image defaults to and the published artifact's Node major is unpinned; declare node-version: ${EXPECTED_NODE_MAJOR}, or list the file in inheritsRunnerNode with the reason it cannot`,
    );
  }

  for (const [file, why] of Object.entries(inheritsRunnerNode)) {
    assert.ok(
      discoveredPublishOrDeploy.some(entry => entry.file === file),
      `inheritsRunnerNode lists ${file}, which the discovery no longer sees publishing or deploying; drop the entry so a new publish step in it is not exempted by a stale reason`,
    );
    assert.match(why, /\S/, `inheritsRunnerNode entry for ${file} must say why it inherits the runner Node`);
  }
});

test('core action references across every workflow use v4 or newer (idb-vector-pw5j)', () => {
  const coreActions = ['actions/checkout', 'actions/setup-node'];

  for (const { file, jobs } of workflows) {
    for (const { name, body } of jobs) {
      const steps = extractSteps(body);
      for (const step of steps) {
        for (const action of coreActions) {
          const regex = new RegExp(`\\buses:\\s*${action}@([^\\s\\n]+)`, 'i');
          const match = regex.exec(step.code);
          if (match) {
            const ref = match[1];
            const majorMatch = /^v?(\d+)/.exec(ref);
            const major = majorMatch ? parseInt(majorMatch[1], 10) : null;
            assert.ok(
              major !== null && major >= 4,
              `"${file}" job "${name}" step ${step.index} uses offending action ref "${action}@${ref}"; core actions must use @v4 or newer to match sibling workflows`,
            );
          }
        }
      }
    }
  }
});
