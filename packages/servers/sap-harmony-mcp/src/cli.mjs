// CLI wrapper — for quick testing and use from shell/scripts.
// Usage:
//   node cli.mjs whoami
//   node cli.mjs perms <quoteCompositeNumber>
//   node cli.mjs quote <quoteCompositeNumber> [param]
//   node cli.mjs opp-quotes <oppId>
//   node cli.mjs opp <oppId>
//   node cli.mjs resolve <i-number|name>
//   node cli.mjs deals <key=value ...>    e.g. deals owner=I077894 quarter=2027 origin=renewal

import * as h from './harmony-client.mjs';

const [cmd, ...args] = process.argv.slice(2);

// Parse `key=value` args into a filters object; comma-splits multi-value fields.
function kvFilters(pairs) {
  const multi = new Set(['status', 'forecast', 'account', 'dealType', 'origin']);
  const numeric = new Set(['top', 'skip']);
  const f = {};
  for (const p of pairs) {
    const i = p.indexOf('=');
    if (i < 0) continue;
    const k = p.slice(0, i);
    let v = p.slice(i + 1);
    if (multi.has(k) && v.includes(',')) v = v.split(',');
    else if (numeric.has(k)) v = Number(v);
    f[k] = v;
  }
  return f;
}

const commands = {
  whoami: () => h.whoami(),
  perms: (n) => h.quotePermissions(n),
  quote: (n, p) => h.quoteRead(n, p),
  'opp-quotes': (id) => h.oppListQuotes(id),
  opp: (id) => h.oppRead(id),
  a8: (...ids) => {
    // last arg may be "all" to include A4, or "refresh"
    const opts = {};
    const rest = ids.filter((a) => {
      if (a === 'all') { opts.type = 'all'; return false; }
      if (a === 'refresh') { opts.refresh = true; return false; }
      return true;
    });
    return h.a8CheckOpps(rest, opts);
  },
  resolve: (q) => h.resolveEmployee(q),
  risk: (...ids) => (ids.length > 1 ? h.readRiskNotesBatch(ids) : h.readRiskNotes(ids[0])),
  // set-risk <oppId> renewalRisk=<code> renewBusScenario=<code>
  'set-risk': (oppId, ...pairs) => {
    const patch = {};
    for (const p of pairs) {
      const i = p.indexOf('=');
      if (i < 0) continue;
      patch[p.slice(0, i)] = p.slice(i + 1);
    }
    return h.setRenewalRisk(oppId, patch);
  },
  // set-risk-notes <oppId> renewalRiskNote=<text> executiveSummary=<text> supportNeeded=<text>
  'set-risk-notes': (oppId, ...pairs) => {
    const patch = {};
    for (const p of pairs) {
      const i = p.indexOf('=');
      if (i < 0) continue;
      patch[p.slice(0, i)] = p.slice(i + 1);
    }
    return h.setRiskNotes(oppId, patch);
  },
  deals: (...pairs) => {
    const f = kvFilters(pairs);
    const { top, skip, orderby, raw, ...filters } = f;
    return h.dealsList(filters, { top, skip, orderby, raw: raw === 'true' });
  },
};

if (!cmd || !commands[cmd]) {
  console.error('Commands: ' + Object.keys(commands).join(', '));
  process.exit(1);
}

try {
  const result = await commands[cmd](...args);
  console.log(JSON.stringify(result, null, 2));
} catch (e) {
  console.error('Error:', e.message);
  process.exit(1);
}
