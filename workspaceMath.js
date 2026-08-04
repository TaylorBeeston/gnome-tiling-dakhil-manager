export function modulo(value, count) {
    if (!Number.isInteger(count) || count < 1)
        throw new RangeError('count must be a positive integer');

    return ((value % count) + count) % count;
}

export function actualWorkspaceForLocal(localIndex, offset, count) {
    return modulo(localIndex + offset, count);
}

export function shiftedOffset(offset, delta, count) {
    return modulo(offset + delta, count);
}

export function treeKey(workspaceIndex, connector) {
    return `${workspaceIndex}:${connector}`;
}

export function parseTreeKey(key) {
    const separator = key.indexOf(':');

    if (separator < 1)
        throw new Error(`Invalid BSP tree key: ${key}`);

    return {
        workspaceIndex: Number.parseInt(key.slice(0, separator), 10),
        connector: key.slice(separator + 1),
    };
}

export function shiftTreeKeyForConnector(key, targetConnector, delta, count) {
    const {workspaceIndex, connector} = parseTreeKey(key);

    if (connector !== targetConnector)
        return key;

    return treeKey(modulo(workspaceIndex + delta, count), connector);
}
