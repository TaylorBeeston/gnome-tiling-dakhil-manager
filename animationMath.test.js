import assert from 'node:assert/strict';
import test from 'node:test';

import {flipTransform, geometryChanged} from './animationMath.js';

test('FLIP transform maps the final rectangle back to the previous rectangle', () => {
    const from = {x: 20, y: 40, width: 800, height: 600};
    const to = {x: 100, y: 120, width: 400, height: 300};
    const transform = flipTransform(from, to);

    assert.deepEqual(transform, {
        translationX: -80,
        translationY: -80,
        scaleX: 2,
        scaleY: 2,
    });
    assert.equal(to.x + transform.translationX, from.x);
    assert.equal(to.y + transform.translationY, from.y);
    assert.equal(to.width * transform.scaleX, from.width);
    assert.equal(to.height * transform.scaleY, from.height);
});

test('geometry equality includes position and dimensions', () => {
    const rect = {x: 0, y: 0, width: 100, height: 100};

    assert.equal(geometryChanged(rect, {...rect}), false);
    assert.equal(geometryChanged(rect, {...rect, width: 101}), true);
    assert.equal(geometryChanged(rect, {...rect, x: 1}), true);
});

test('FLIP rejects an unusable target rectangle', () => {
    assert.throws(
        () => flipTransform(
            {x: 0, y: 0, width: 1, height: 1},
            {x: 0, y: 0, width: 0, height: 1}
        ),
        RangeError
    );
});
