/**
 * Replaces placeholders like {{TEXT}} in the JSON object with actual values.
 * Copied from Pluely's deepVariableReplacer
 */
export function deepVariableReplacer(
    node: any,
    variables: Record<string, string>
): any {
    if (typeof node === "string") {
        let result = node;
        for (const [key, value] of Object.entries(variables)) {
            // Replace {{KEY}} with value
            result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
        }
        return result;
    }
    if (Array.isArray(node)) {
        return node.map((item) => deepVariableReplacer(item, variables));
    }
    if (node && typeof node === "object") {
        const newNode: { [key: string]: any } = {};
        for (const key in node) {
            newNode[key] = deepVariableReplacer(node[key], variables);
        }
        return newNode;
    }
    return node;
}
