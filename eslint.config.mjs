import js from '@eslint/js';
import oxlint from 'eslint-plugin-oxlint';
import tseslint from 'typescript-eslint';

const blockComments = {
  meta: {
    type: 'layout',
    messages: {
      block:
        'Write a comment that spans lines as one /* */ block, not a run of // lines.',
    },
  },
  create(context) {
    return {
      Program() {
        const comments = context.sourceCode.getAllComments();
        comments.forEach((comment, i) => {
          const previous = comments[i - 1];
          const joinsPrevious =
            comment.type === 'Line' &&
            previous?.type === 'Line' &&
            previous.loc.end.line === comment.loc.start.line - 1;
          const startsRun =
            !joinsPrevious &&
            comment.type === 'Line' &&
            comments[i + 1]?.type === 'Line' &&
            comments[i + 1].loc.start.line === comment.loc.end.line + 1;
          if (startsRun) context.report({ node: comment, messageId: 'block' });
        });
      },
    };
  },
};

export default tseslint.config(
  {
    ignores: ['node_modules', 'dist', 'build', 'coverage', '.output'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  oxlint.buildFromOxlintConfigFile('.oxlintrc.json'),
  {
    plugins: { ktchn: { rules: { 'block-comments': blockComments } } },
    rules: {
      'ktchn/block-comments': 'error',
      'prefer-const': 'error',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  }
);
