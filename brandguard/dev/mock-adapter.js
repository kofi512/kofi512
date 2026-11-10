'use strict';
// In-memory stand-in for src/ps/adapter.js so the panel runs in a normal browser / in tests.

const { applyFixToModel } = require('../src/core/rules');
const { applyPlan } = require('../src/core/variants');
const { sampleDoc } = require('./sample-doc');

function createMockAdapter(initialDoc) {
  let doc = initialDoc === undefined ? sampleDoc() : initialDoc;
  const log = [];
  let stored = null;
  return {
    log,
    setDoc(d) { doc = d; },
    async readDocument() { return doc ? JSON.parse(JSON.stringify(doc)) : null; },
    async selectLayer(id) { log.push(['select', id]); },
    async applyFixes(fixes, name) {
      log.push(['applyFixes', name, fixes.length]);
      for (const f of fixes) doc = applyFixToModel(doc, f);
      return { applied: fixes.length, failed: [] };
    },
    async createVariant(plan, opts) {
      log.push(['createVariant', plan.format.id, !!(opts && opts.exportFolder)]);
      return { name: applyPlan(doc, plan).name };
    },
    async reactivateSource() {},
    async pickFolder() { return { name: 'exports' }; },
    async loadSpec() { return stored; },
    async saveSpec(s) { stored = JSON.parse(JSON.stringify(s)); },
    async importSpecFile() { return null; },
    async exportSpecFile() { return true; },
    onDocumentChange() { return () => {}; },
  };
}

module.exports = { createMockAdapter };
