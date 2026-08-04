export function geometryChanged(from, to) {
    return from.x !== to.x
        || from.y !== to.y
        || from.width !== to.width
        || from.height !== to.height;
}

export function flipTransform(from, to) {
    if (to.width <= 0 || to.height <= 0)
        throw new RangeError('target geometry must have positive dimensions');

    return {
        translationX: from.x - to.x,
        translationY: from.y - to.y,
        scaleX: from.width / to.width,
        scaleY: from.height / to.height,
    };
}
