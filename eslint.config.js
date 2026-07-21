// @ts-check
const tseslint = require('@typescript-eslint/eslint-plugin');
const tsparser = require('@typescript-eslint/parser');

/** @type {import("eslint").Linter.Config[]} */
module.exports = [
    {
        // Type rules mirror ironbee-cli: explicit annotations everywhere + 4-space indent.
        // Applied to shipped source.
        files: ['src/**/*.ts'],
        languageOptions: {
            parser: tsparser,
            parserOptions: {
                project: './tsconfig.json',
            },
        },
        plugins: {
            '@typescript-eslint': tseslint,
        },
        rules: {
            // Enforce 4-space indentation.
            indent: ['error', 4, { SwitchCase: 1 }],

            // Always require curly braces for if/else/for/while.
            curly: ['error', 'all'],

            // Require explicit return types on functions.
            '@typescript-eslint/explicit-function-return-type': [
                'error',
                {
                    allowExpressions: false,
                    allowTypedFunctionExpressions: false,
                    allowHigherOrderFunctions: false,
                },
            ],

            // Require type annotations on variables, parameters, and properties.
            '@typescript-eslint/typedef': [
                'error',
                {
                    arrayDestructuring: false,
                    arrowParameter: true,
                    memberVariableDeclaration: true,
                    objectDestructuring: false,
                    parameter: true,
                    propertyDeclaration: true,
                    variableDeclaration: true,
                    variableDeclarationIgnoreFunction: false,
                },
            ],
        },
    },
    {
        // Tests: keep the same 4-space indent for a consistent codebase, but don't force the heavy
        // type annotations (tests lean on inference). No `project` so out-of-tsconfig files are fine.
        files: ['test/**/*.ts'],
        languageOptions: {
            parser: tsparser,
        },
        rules: {
            indent: ['error', 4, { SwitchCase: 1 }],
            curly: ['error', 'all'],
        },
    },
];
