# ClawdHub CLI

Install

```
npm i -g clawdhub
```

Auth (publish)

```
clawdhub login
clawdhub whoami
```

Search

```
clawdhub search "postgres backups"
```

Install

```
clawdhub install my-skill
clawdhub install my-skill --version 1.2.3
```

Update (hash-based match + upgrade)

```
clawdhub update my-skill
clawdhub update my-skill --version 1.2.3
clawdhub update --all
clawdhub update my-skill --force
clawdhub update --all --no-input --force
```

List

```
clawdhub list
```

Publish

```
clawdhub publish ./my-skill --slug my-skill --name "My Skill" --version 1.2.0 --changelog "Fixes + docs"
```

Notes

- Default registry: https://clawdhub.com (override with CLAWDHUB_REGISTRY or --registry)
- Default workdir: cwd; install dir: ./skills (override with --workdir / --dir)
- Update command hashes local files, resolves matching version, and upgrades to latest unless --version is set
