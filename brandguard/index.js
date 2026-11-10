'use strict';
// UXP entry point: wires the real Photoshop adapter into the panel UI.
const { start } = require('./src/ui/app');
const adapter = require('./src/ps/adapter');

start(adapter, document.getElementById('app'));
