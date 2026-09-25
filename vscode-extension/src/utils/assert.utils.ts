export function assertTrue(
    value: unknown | undefined,
    errorMessage: string = 'Found a false value',
    muteError = false
): asserts value is true {
    if (!value) {
        if (muteError) {
            console.assert(!!value, errorMessage);
        } else {
            throw new Error(errorMessage);
        }
    }
}

export function assertFalse(
    value: unknown | undefined,
    errorMessage: string = 'Found a true value',
    muteError = false
): asserts value is true {
    if (value) {
        if (muteError) {
            console.assert(!!value, errorMessage);
        } else {
            throw new Error(errorMessage);
        }
    }
}

export function assertDefined<T>(
    value: T | undefined,
    errorMessage: string = 'Found an unexpected nullable value',
    muteError = false
): asserts value is T {
    if (!value) {
        if (muteError) {
            console.assert(!!value, errorMessage);
        } else {
            throw new Error(errorMessage);
        }
    }
}
