import assert from 'node:assert/strict';
import test from 'node:test';

import {
    actualWorkspaceForLocal,
    migrateTreeConnectors,
    modulo,
    resizedSplitRatio,
    parseTreeKey,
    shiftedOffset,
    shiftTreeKeyForConnector,
    treeKey,
} from './workspaceMath.js';

test('modulo wraps workspace indices in both directions', () => {
    assert.equal(modulo(10, 10), 0);
    assert.equal(modulo(-1, 10), 9);
});

test('local slots resolve through the monitor offset', () => {
    assert.equal(actualWorkspaceForLocal(6, 4, 10), 0);
    assert.equal(actualWorkspaceForLocal(0, 9, 10), 9);
});

test('shifting an inactive monitor preserves its visible local slot', () => {
    const oldGlobalWorkspace = 3;
    const newGlobalWorkspace = 5;
    const oldOffset = 6;
    const visibleLocalWorkspace = modulo(oldGlobalWorkspace - oldOffset, 10);
    const newOffset = shiftedOffset(
        oldOffset,
        newGlobalWorkspace - oldGlobalWorkspace,
        10
    );

    assert.equal(modulo(newGlobalWorkspace - newOffset, 10), visibleLocalWorkspace);
});

test('tree keys follow shifted inactive monitors without collisions', () => {
    const keys = Array.from({length: 10}, (_, workspaceIndex) =>
        treeKey(workspaceIndex, 'Meta-0'));
    const shifted = keys.map(key =>
        shiftTreeKeyForConnector(key, 'Meta-0', 3, 10));

    assert.equal(new Set(shifted).size, 10);
    assert.deepEqual(
        parseTreeKey(
            shiftTreeKeyForConnector(
                treeKey(9, 'Meta-0'),
                'Meta-0',
                3,
                10
            )
        ),
        {workspaceIndex: 2, connector: 'Meta-0'}
    );
    assert.equal(
        shiftTreeKeyForConnector(treeKey(4, 'eDP-1'), 'Meta-0', 3, 10),
        treeKey(4, 'eDP-1')
    );
});

test('fallback tree connectors migrate independently of saved offsets', () => {
    const laptopTree = {name: 'laptop'};
    const virtualTree = {name: 'virtual'};
    const trees = new Map([
        [treeKey(3, 'monitor-0'), laptopTree],
        [treeKey(7, 'monitor-1'), virtualTree],
        [treeKey(4, 'unchanged'), {name: 'unchanged'}],
    ]);
    const migrated = migrateTreeConnectors(trees, new Map([
        [0, 'eDP-1'],
        [1, 'Meta-0'],
    ]));

    assert.equal(migrated.get(treeKey(3, 'eDP-1')), laptopTree);
    assert.equal(migrated.get(treeKey(7, 'Meta-0')), virtualTree);
    assert.equal(migrated.get(treeKey(4, 'unchanged')).name, 'unchanged');
    assert.equal(migrated.has(treeKey(3, 'monitor-0')), false);
});

test('pointer resize adjusts the shared split from either child', () => {
    assert.equal(resizedSplitRatio(0.5, 100, 1000, true), 0.6);
    assert.equal(resizedSplitRatio(0.5, 100, 1000, false), 0.4);
    assert.equal(resizedSplitRatio(0.85, 100, 1000, true), 0.9);
    assert.equal(resizedSplitRatio(0.15, 100, 1000, false), 0.1);
});
