# One package; the skill catalogue and Sandcastle stay outside

ktchn is a single package with module folders, not a workspace of packages. Separation comes from dependency direction, enforced by an import-boundary lint rule, not from package boundaries. We split into packages only when something needs to deploy or publish on its own.

gstack (the skill catalogue) and Sandcastle stay in their own repos and are consumed as dependencies. gstack is content with its own rhythm and is useful outside ktchn. Keeping it in a separate repo stops runtime code drifting back into skill folders, which is the problem ktchn exists to fix. Sandcastle gets vendored only on the day we decide to fork it.
