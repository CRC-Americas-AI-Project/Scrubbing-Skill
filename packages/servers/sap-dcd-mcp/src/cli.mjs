// CLI wrapper — quick shell/script testing.
//   node cli.mjs whoami
//   node cli.mjs search Amperex
//   node cli.mjs contracts 2982402
//   node cli.mjs clauses 2982402 3063438814
//   node cli.mjs documents 3063438814
//   node cli.mjs download 3063438814 [documentId] [outDir]
//
// Everything prints JSON to stdout.

import * as d from './dcd-client.mjs';

const [cmd, ...args] = process.argv.slice(2);

const commands = {
  whoami:    () => d.whoami(),
  search:    (term) => {
    if (!term) throw new Error('search <term>');
    return d.search(term);
  },
  contracts: (erp) => {
    if (!erp) throw new Error('contracts <erp>');
    return d.customerContracts(erp);
  },
  clauses:   (erp, caseId) => {
    if (!erp) throw new Error('clauses <erp> [caseId]');
    return d.contractClauses(erp, caseId);
  },
  documents: (caseId) => {
    if (!caseId) throw new Error('documents <caseId>');
    return d.contractDocuments(caseId);
  },
  download:  (caseId, documentId, outDir) => {
    if (!caseId) throw new Error('download <caseId> [documentId] [outDir]');
    return d.downloadContract(caseId, documentId, outDir);
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
