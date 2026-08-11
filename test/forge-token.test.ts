/*
 * Handing a configured GitLab token to `glab`.
 *
 * `glab auth login` against a SELF-HOSTED instance defaults to an OAuth device flow that
 * needs an application registered on that instance, so the login refuses outright with
 * "Set 'client_id' first" and every MR lookup then fails with "no known GitLab host".
 * There is simply no way in — which is why the PR/MR half of Studio had never worked on
 * a self-hosted setup, without anything appearing broken.
 *
 * glab prefers GITLAB_TOKEN over its own stored credentials, and Studio already keeps a
 * token for the intake adapter, so one credential can serve both.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { createForge } from '../server/forge.ts';
import type { Provider } from '../server/forge.ts';

/** A provider that records the env it was handed instead of shelling out. */
function spy() {
  const seen: NodeJS.ProcessEnv[] = [];
  const provider: Provider = {
    id: 'gitlab',
    cli: 'glab',
    // This double never lists reviews; the interface requires the member.
    reviews: async () => [],
    async view(_b, _cwd, env) {
      seen.push(env || {});
      return null;
    },
    async create(_b, _cwd, env) {
      seen.push(env || {});
      return { ok: false, stderr: 'not today' };
    },
  };
  return { provider, seen };
}

const member = { repo: 'accept-blue', path: '/code/accept-blue/wt', branch: 'feature/x' };

test('a configured token reaches glab, with the host it belongs to', async () => {
  const { provider, seen } = spy();
  const forge = createForge({
    cfg: { sources: { gitlab: { host: 'https://gitlab1.develop.accept.blue', token: 'glpat-abc' } } },
    providers: [provider],
    isInstalled: () => true,
  });
  await forge.ciForRepo({ ...member, worktreePath: member.path });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].GITLAB_TOKEN, 'glpat-abc');
  // Scheme stripped: glab wants a host, and a token is worthless without knowing
  // which instance it belongs to — that is the whole "no known GitLab host" failure.
  assert.equal(seen[0].GITLAB_HOST, 'gitlab1.develop.accept.blue');
});

test('a trailing slash on the host does not become part of it', () => {
  const { provider, seen } = spy();
  const forge = createForge({
    cfg: { sources: { gitlab: { host: 'https://gl.example.com/', token: 't' } } },
    providers: [provider],
    isInstalled: () => true,
  });
  return forge.ciForRepo({ ...member, worktreePath: member.path }).then(() => {
    assert.equal(seen[0].GITLAB_HOST, 'gl.example.com');
  });
});

test('with NO token configured, nothing is injected — an existing glab login still wins', async () => {
  const { provider, seen } = spy();
  const forge = createForge({ cfg: {}, providers: [provider], isInstalled: () => true });
  await forge.ciForRepo({ ...member, worktreePath: member.path });

  assert.equal('GITLAB_TOKEN' in seen[0], false, 'an empty token must not shadow stored credentials');
  assert.equal('GITLAB_HOST' in seen[0], false);
});

test('a host with no token injects neither — a half-configured source is not a credential', async () => {
  const { provider, seen } = spy();
  const forge = createForge({
    cfg: { sources: { gitlab: { host: 'https://gl.example.com' } } },
    providers: [provider],
    isInstalled: () => true,
  });
  await forge.ciForRepo({ ...member, worktreePath: member.path });
  assert.equal('GITLAB_HOST' in seen[0], false);
});
