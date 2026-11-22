# Pi packages

This branch is the single install target for this repository:

```sh
pi install git:github.com/thoitiettxl-cyber/pi@pi-packages
```

Pi ignores `@ref` when identifying installed git packages and uses one checkout per repository. Never install two branches of this repository: installing the second replaces the first.

Develop packages on development branches, then submit PRs into `pi-packages` with each package in its own subfolder.

To try a development branch for one invocation without changing settings:

```sh
pi -e git:github.com/thoitiettxl-cyber/pi@<branch>
```

Temporary (`-e`) git checkouts include the ref in their cache key, so they do not overwrite the installed checkout or another ref's temporary checkout.

To disable one sub-package, replace the string entry in `~/.pi/agent/settings.json` with a package object. For example, disable the provider while keeping other resources:

```json
{
  "packages": [
    {
      "source": "git:github.com/thoitiettxl-cyber/pi@pi-packages",
      "extensions": ["!provider-devin/**"]
    }
  ]
}
```

Filters use paths relative to the package root. Omitted resource types load normally; `[]` disables all resources of that type. To disable a sub-package with both extensions and skills, exclude its subfolder in both `extensions` and `skills`.
