import assert from 'node:assert/strict';
import test from 'node:test';

import {
    actualWorkspaceForLocal,
    modulo,
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
