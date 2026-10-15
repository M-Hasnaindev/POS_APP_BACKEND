const { fail } = require('./adminStore');
const { dotenvValue } = require('./adminEnvironment');
const { connector } = require('./adminApps');

// Only application configuration is exposed, using the existing allowlist.
function createAppDetails(apps, store, dir, remote = connector, releaseReader = readReleases) {
  async function info(id) {
    const app = await apps.get(id);
    if (id !== 'pos') {
      const result = await remote(app, '/api/admin-connector/info');
      if (!result.info || typeof result.info !== 'object') throw fail('App information is unavailable.', 502);
      return {...result.info, id: app.id, name: app.name, apiUrl: app.baseUrl + '/api'};
    }
    const base = process.env.APP_PUBLIC_URL || 'https://pos-app-backend-steel.vercel.app';
    return {
      id, name: 'POS', description: 'Cherry’s point of sale application',
      apiUrl: base.replace(/\/$/, '') + '/api', backendUrl: base,
      backendVersion: require('../package.json').version,
      environment: process.env.VERCEL_ENV || process.env.NODE_ENV || 'development',
      deployment: process.env.VERCEL_GIT_COMMIT_SHA || '',
      versionSource: 'Company release records in dbo.AppInfo; not an installed device version',
      links: [{label: 'Backend', url: base}],
      releases: await releaseReader(dir.tenants),
    };
  }
  async function environment(id) {
    const app = await apps.get(id);
    if (id === 'pos') return dir.environment().map(name => ({name, value: dir.masked(process.env[name]), configured: Boolean(process.env[name])}));
    const result = await remote(app, '/api/admin-connector/environment');
    if (!Array.isArray(result.variables)) throw fail('App environment is unavailable.', 502);
    // Mask again at the boundary, even if a connector accidentally returns plaintext.
    return result.variables.map(v => ({name: v.name, configured: Boolean(v.configured), value: v.configured ? '••••••••' : ''}));
  }
  async function reveal(id, names, actor) {
    const app = await apps.get(id);
    const allowed = (await environment(id)).map(v => v.name);
    if (!Array.isArray(names) || names.length > 100 || !names.every(n => typeof n === 'string' && allowed.includes(n))) throw fail('Invalid environment selection.');
    await store.audit(actor, 'app.environment.revealed', JSON.stringify({appId:id,names}).slice(0,500));
    if (id === 'pos') return names.map(name => ({name, value: process.env[name] || ''}));
    const result = await remote(app, '/api/admin-connector/environment/reveal', {names});
    if (!Array.isArray(result.variables) || result.variables.some(v => !names.includes(v.name) || typeof v.value !== 'string')) throw fail('Invalid environment response.', 502);
    return result.variables;
  }
  async function download(id, actor) {
    const app = await apps.get(id);
    await store.audit(actor, 'app.environment.downloaded', id);
    if (id === 'pos') return dir.environment().map(n => n + '=' + dotenvValue(process.env[n] || '')).join('\n') + '\n';
    const result = await remote(app, '/api/admin-connector/environment/download', {});
    if (typeof result.content !== 'string') throw fail('Invalid environment export.', 502);
    return result.content;
  }
  async function overview(id) {
    const app = await apps.get(id);
    if (id !== 'pos') {
      const result = await remote(app, '/api/admin-connector/overview');
      if (!result.overview) throw fail('App overview is unavailable.', 502);
      return result.overview;
    }
    const blocked = (await store.restrictions()).filter(r => r.restricted);
    return {tenantCount:dir.tenants.length,restrictedTenants:blocked.filter(r=>r.scope==='tenant').length,
      restrictedCompanies:blocked.filter(r=>r.scope==='company').length,restrictedUsers:blocked.filter(r=>r.scope==='user').length};
  }
  return {info, environment, reveal, download, overview};
}
async function readReleases(tenants) {
  const {getPoolForTenant, sql} = require('../config/db');
  return (await Promise.all(tenants.map(async t => {
    const identity = {tenantId:t.id,tenantName:t.label,appName:'CherryTechApp'};
    try {
      const pool = await getPoolForTenant(t.id);
      const request = pool.request(); request.timeout = 8000;
      const result = await request.input('name',sql.VarChar(150),'CherryTechApp').query('SELECT AppName, AppVersion, AppLink FROM dbo.AppInfo WHERE AppName = @name');
      if (!result.recordset.length) return [{...identity,error:'No release record configured for this app.'}];
      return result.recordset.map(r => ({...identity,appName:String(r.AppName),version:String(r.AppVersion || ''),url:String(r.AppLink || '')}));
    } catch { return [{...identity,error:'Company release information is currently unavailable.'}]; }
  }))).flat();
}
module.exports = {createAppDetails, readReleases};
