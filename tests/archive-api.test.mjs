import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import saveHandler from '../api/save.js';
import loadHandler from '../api/load.js';

const originalFetch = globalThis.fetch;
const originalEnv = {
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY
};

const verifiedUser = {
  id: 'user-123',
  email: 'person@example.com',
  email_confirmed_at: '2026-11-27T00:00:00.000Z'
};

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
    async text() { return typeof body === 'string' ? body : JSON.stringify(body); }
  };
}

function makeRes() {
  const result = { headers: {}, statusCode: null, body: undefined, ended: false };
  return {
    result,
    setHeader(name, value) { result.headers[name] = value; },
    status(code) { result.statusCode = code; return this; },
    json(body) { result.body = body; return this; },
    end() { result.ended = true; return this; }
  };
}

function req({ method = 'POST', token = 'token-123', body = {} } = {}) {
  return {
    method,
    headers: token === null ? {} : { authorization: token ? `Bearer ${token}` : '' },
    body
  };
}

function setConfiguredEnv() {
  process.env.SUPABASE_URL = 'https://project.supabase.co';
  process.env.SUPABASE_SERVICE_KEY = 'service-key-for-test';
}

function mockAuthAndDb({ dbResponse, authResponse = response(verifiedUser), calls = [] } = {}) {
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith('/auth/v1/user')) return authResponse;
    return dbResponse;
  };
  return calls;
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('both archive routes reject missing or malformed bearer tokens before database access', async (t) => {
  setConfiguredEnv();
  for (const [name, handler] of [['save', saveHandler], ['load', loadHandler]]) {
    await t.test(`${name} rejects missing token`, async () => {
      const calls = [];
      globalThis.fetch = async (...args) => { calls.push(args); return response({}); };
      const res = makeRes();
      await handler(req({ token: null, body: { user_id: verifiedUser.email, data: {} } }), res);
      assert.equal(res.result.statusCode, 401);
      assert.deepEqual(res.result.body, { error: 'Sign in required' });
      assert.equal(calls.length, 0);
    });

    await t.test(`${name} rejects malformed token`, async () => {
      const calls = [];
      globalThis.fetch = async (...args) => { calls.push(args); return response({}); };
      const request = req({ body: { user_id: verifiedUser.email, data: {} } });
      request.headers.authorization = 'Basic abc';
      const res = makeRes();
      await handler(request, res);
      assert.equal(res.result.statusCode, 401);
      assert.equal(calls.length, 0);
    });
  }
});

test('method handling rejects non-POST requests without contacting Supabase', async (t) => {
  setConfiguredEnv();
  for (const [name, handler] of [['save', saveHandler], ['load', loadHandler]]) {
    await t.test(name, async () => {
      const calls = [];
      globalThis.fetch = async (...args) => { calls.push(args); return response({}); };
      const res = makeRes();
      await handler(req({ method: 'GET', body: {} }), res);
      assert.equal(res.result.statusCode, 405);
      assert.deepEqual(res.result.body, { error: 'Method not allowed' });
      assert.equal(res.result.headers.Allow, 'POST');
      assert.equal(calls.length, 0);
    });
  }
});

test('forged user_id is rejected after token verification and does not touch archives', async () => {
  setConfiguredEnv();
  const calls = [];
  mockAuthAndDb({ dbResponse: response({}), calls });
  const res = makeRes();
  await saveHandler(req({ body: { user_id: 'victim@example.com', data: { ok: true } } }), res);
  assert.equal(res.result.statusCode, 403);
  assert.deepEqual(res.result.body, { error: 'Archive owner mismatch' });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/auth\/v1\/user$/);
});

test('save uses the verified email in the archive body and succeeds', async () => {
  setConfiguredEnv();
  const calls = [];
  mockAuthAndDb({ dbResponse: response({}, 201), calls });
  const data = { familyInfo: { region: 'Fujian' }, todos: [] };
  const res = makeRes();
  await saveHandler(req({ body: { user_id: verifiedUser.email, data } }), res);
  assert.equal(res.result.statusCode, 200);
  assert.deepEqual(res.result.body, { ok: true });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, 'https://project.supabase.co/rest/v1/archives');
  assert.deepEqual(JSON.parse(calls[1].options.body), { user_id: verifiedUser.email, data });
  assert.equal(calls[1].options.method, 'POST');
});

test('load uses the verified email, quotes filter punctuation, and requests newest snapshot', async () => {
  setConfiguredEnv();
  const user = { ...verifiedUser, email: 'o"hara+archive@example.com' };
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith('/auth/v1/user')) return response(user);
    return response([{ data: { version: 7 } }]);
  };
  const res = makeRes();
  await loadHandler(req({ body: { user_id: user.email } }), res);
  assert.equal(res.result.statusCode, 200);
  assert.deepEqual(res.result.body, { data: { version: 7 } });
  assert.equal(calls.length, 2);
  const dbUrl = new URL(calls[1].url);
  assert.equal(dbUrl.searchParams.get('user_id'), 'eq."o\\"hara+archive@example.com"');
  assert.equal(dbUrl.searchParams.get('order'), 'created_at.desc,id.desc');
  assert.equal(dbUrl.searchParams.get('limit'), '1');
});

test('unverified auth user is rejected before archive access', async () => {
  setConfiguredEnv();
  const calls = [];
  mockAuthAndDb({
    authResponse: response({ id: 'user-123', email: verifiedUser.email, email_confirmed_at: null }),
    dbResponse: response({}),
    calls
  });
  const res = makeRes();
  await loadHandler(req({ body: { user_id: verifiedUser.email } }), res);
  assert.equal(res.result.statusCode, 403);
  assert.deepEqual(res.result.body, { error: 'Verified email required' });
  assert.equal(calls.length, 1);
});

test('auth failure is normalized and does not expose upstream response text', async (t) => {
  setConfiguredEnv();
  await t.test('invalid token', async () => {
    const calls = [];
    mockAuthAndDb({ authResponse: response('jwt details and secrets', 401), dbResponse: response({}), calls });
    const res = makeRes();
    await loadHandler(req({ body: { user_id: verifiedUser.email } }), res);
    assert.equal(res.result.statusCode, 401);
    assert.deepEqual(res.result.body, { error: 'Unable to verify sign in' });
    assert.equal(calls.length, 1);
  });

  await t.test('auth transport failure', async () => {
    globalThis.fetch = async () => { throw new Error('private upstream detail'); };
    const res = makeRes();
    await loadHandler(req({ body: { user_id: verifiedUser.email } }), res);
    assert.equal(res.result.statusCode, 503);
    assert.deepEqual(res.result.body, { error: 'Archive service unavailable' });
    assert.doesNotMatch(JSON.stringify(res.result.body), /private upstream detail/);
  });
});

test('database failures are visible as generic gateway/service errors without raw details', async (t) => {
  setConfiguredEnv();
  await t.test('database HTTP failure', async () => {
    const calls = [];
    mockAuthAndDb({ dbResponse: response('database password leak', 500), calls });
    const res = makeRes();
    await saveHandler(req({ body: { user_id: verifiedUser.email, data: {} } }), res);
    assert.equal(res.result.statusCode, 502);
    assert.deepEqual(res.result.body, { error: 'Archive save failed' });
    assert.doesNotMatch(JSON.stringify(res.result.body), /database password leak/);
  });

  await t.test('database transport failure', async () => {
    let count = 0;
    globalThis.fetch = async () => {
      count += 1;
      if (count === 1) return response(verifiedUser);
      throw new Error('socket credentials');
    };
    const res = makeRes();
    await loadHandler(req({ body: { user_id: verifiedUser.email } }), res);
    assert.equal(res.result.statusCode, 503);
    assert.deepEqual(res.result.body, { error: 'Archive service unavailable' });
  });
});

test('save rejects invalid archive data before database access', async () => {
  setConfiguredEnv();
  const calls = [];
  mockAuthAndDb({ dbResponse: response({}), calls });
  const res = makeRes();
  await saveHandler(req({ body: { user_id: verifiedUser.email, data: [] } }), res);
  assert.equal(res.result.statusCode, 400);
  assert.deepEqual(res.result.body, { error: 'Invalid archive data' });
  assert.equal(calls.length, 1);
});

test('missing Supabase configuration returns a generic service error without fetch', async (t) => {
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_KEY;
  for (const [name, handler] of [['save', saveHandler], ['load', loadHandler]]) {
    await t.test(name, async () => {
      const calls = [];
      globalThis.fetch = async (...args) => { calls.push(args); return response({}); };
      const res = makeRes();
      await handler(req({ body: { user_id: verifiedUser.email, data: {} } }), res);
      assert.equal(res.result.statusCode, 503);
      assert.deepEqual(res.result.body, { error: 'Archive service unavailable' });
      assert.equal(calls.length, 0);
    });
  }
});

test('frontend archive calls use the current session bearer and omit user_id', async () => {
  const source = readFileSync(new URL('../public/agent.html', import.meta.url), 'utf8');
  const preamble = source.split('\n  const API_URL')[0].split('<script>')[1];
  const calls = [];
  const session = { access_token: 'access-token', user: { id: 'user-123', email: verifiedUser.email } };
  const statusNode = { hidden: false, textContent: '' };
  const context = {
    console,
    currentLang: 'en',
    familyInfo: {},
    todos: [],
    window: { supabase: { createClient: () => ({ auth: { getSession: async () => ({ data: { session }, error: null }) } }) } },
    document: {
      getElementById: () => statusNode,
      querySelectorAll: () => []
    },
    fetch: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, async json() { return { data: null }; } };
    }
  };
  vm.createContext(context);
  vm.runInContext(preamble, context);
  await vm.runInContext('archiveInitialization', context);
  await vm.runInContext('saveToServer()', context);
  assert.deepEqual(calls.map(call => call.url), ['/api/load', '/api/save']);
  for (const call of calls) {
    assert.equal(call.options.headers.Authorization, 'Bearer access-token');
    assert.equal(Object.prototype.hasOwnProperty.call(JSON.parse(call.options.body), 'user_id'), false);
  }
});

test('frontend pauses automatic saving when archive load fails', async () => {
  const source = readFileSync(new URL('../public/agent.html', import.meta.url), 'utf8');
  const preamble = source.split('\n  const API_URL')[0].split('<script>')[1];
  const calls = [];
  const session = { access_token: 'access-token', user: { id: 'user-123', email: verifiedUser.email } };
  const statusNode = { hidden: false, textContent: '' };
  const context = {
    console,
    currentLang: 'en',
    familyInfo: {},
    todos: [],
    window: { supabase: { createClient: () => ({ auth: { getSession: async () => ({ data: { session }, error: null }) } }) } },
    document: {
      getElementById: () => statusNode,
      querySelectorAll: () => []
    },
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (url === '/api/load') throw new Error('network down');
      return { ok: true, async json() { return { data: null }; } };
    }
  };
  vm.createContext(context);
  vm.runInContext(preamble, context);
  await vm.runInContext('archiveInitialization', context);
  await vm.runInContext('saveToServer()', context);
  assert.deepEqual(calls.map(call => call.url), ['/api/load']);
  assert.match(statusNode.textContent, /自动保存|Auto-save/);
});
