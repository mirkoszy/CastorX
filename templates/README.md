# CastorX service templates (Backstage)

Four Backstage software templates, each generating a hello-world service. The templates are the single source of this code:

| Template          | Stack                                   |
|-------------------|-----------------------------------------|
| `go-service`      | Go 1.24, net/http, client_golang        |
| `python-service`  | Python, FastAPI, prometheus-client      |
| `node-service`    | Node.js 22, Express 5, prom-client      |
| `java-service`    | Java 21, Spring Boot 3.5, Micrometer    |

Every generated service gets the same platform contract: a small REST API, `/healthz`, `/readyz`,
`/metrics` (`http_requests_total`, `http_request_duration_seconds`, `app_info`), `$PORT`,
graceful `SIGTERM` shutdown, a Dockerfile, a CI pipeline and a `catalog-info.yaml`.

## What a template run does

1. **Asks for**: name, description, owner (group), optional system, repository location
   (GitHub or GitLab, including GitLab subgroups), visibility. The Java template also asks for a Maven group ID.
2. `fetch:template` renders `skeleton/` (service name, Go module path, Java package, catalog entity…).
3. Adds the CI pipeline for the chosen host (copied with `fetch:plain`, so pipeline expressions stay untouched):
   - GitHub: `.github/workflows/ci.yaml`: test on every push/PR, then build and push to
     `ghcr.io/<owner>/<repo>` from the default branch.
   - GitLab: `.gitlab-ci.yml`: test, then build and push to the project's container registry from the default branch.
4. Publishes the repo (`publish:github` or `publish:gitlab`, default branch `main`).
5. Registers the component in the catalog (`catalog:register`) and links to the repo and catalog page.

```
<language>-service/
├── template.yaml              # parameters + steps
├── skeleton/                  # templated source (${{ values.* }})
└── ci/
    ├── github/workflows/ci.yaml   # copied into .github/ of the new repo
    └── gitlab/.gitlab-ci.yml
```

The GitHub workflow is stored without the `.github` prefix so this templates repo does not run
it as its own workflow. The template copies it into `.github/` of the generated repo.

## Tenant onboarding template

`tenant-onboarding` registers a tenant or customer. It does not create a repository or any GCP resources.

**Asks for**: tenant name, a link to the tenant's existing GitHub repository, and either a GCP service
account email (recommended) or a service account JSON key.

**What a run does**:

1. Opens a pull request on the tenant registry repository, adding `tenants/<tenant>/catalog-info.yaml`
   (a catalog `Resource` of type `tenant`). The tenant appears in the catalog once the pull request merges.
2. If a key was supplied, stores it as the `GCP_SA_KEY` secret in the `tenant-<tenant>` GitHub environment
   on the registry repository, readable only by workflows running from `main`. A workflow reads it with:

   ```yaml
   jobs:
     deploy:
       environment: tenant-acme
       steps:
         - uses: google-github-actions/auth@v2
           with:
             credentials_json: ${{ secrets.GCP_SA_KEY }}
   ```

The key never reaches the pull request or the generated files, and Backstage redacts it from task logs.
To rotate a key, run the template again for the same tenant. The key's format is not validated, so a
malformed key only fails when a workflow uses it.

**Setup**:

1. Create the registry as a **private** repository, because tenant records name your customers.
   `mirkoszy/castorx-tenants` is a placeholder; change it in both steps of `tenant-onboarding/template.yaml`.
   Secrets in environments of a private repository need a paid GitHub plan.
2. Give the scaffolder's GitHub token permission to push branches, open pull requests and administer
   the registry repository (creating environments and secrets requires admin access).
3. Add the registry to `app-config.yaml` so merged tenants reach the catalog:

   ```yaml
   catalog:
     locations:
       - type: url
         target: https://github.com/<org>/<registry-repo>/blob/main/tenants/*/catalog-info.yaml
         rules:
           - allow: [Resource]
   ```

## Local testing

The `Makefile` renders a template the way the Backstage scaffolder does (`tools/scaffold.js`:
same `${{ }}` engine, parameter defaults and validation, step conditions, `fetch:template` /
`fetch:plain`), writes the generated project to `.out/`, and can run its tests. The publish and
catalog-register steps are only printed, so nothing is created on GitHub, GitLab or in Backstage.

Requires Node.js 20+, plus Docker (default) or local toolchains (`RUNNER=local`).

```bash
make help                                    # targets and variables
make render TEMPLATE=java NAME=orders-api    # generate into .out/java-github-com-orders-api
make test   TEMPLATE=python                  # generate + run the project's tests in Docker
make test   TEMPLATE=go RUNNER=local         # ... or with your local go / python3 / npm / mvn
make render TEMPLATE=node HOST=gitlab.com REPO_OWNER=acme/payments   # GitLab variant (.gitlab-ci.yml)
make run    TEMPLATE=go                      # generate, build the image, run on localhost:8080
make test-all                                # all templates, GitHub + GitLab variants
make clean
```

Variables: `TEMPLATE` (go, python, node, java), `NAME`, `DESCRIPTION`, `OWNER`, `SYSTEM`,
`HOST` (github.com, gitlab.com), `REPO_OWNER`, `GROUP_ID` (Java), `VISIBILITY`, `RUNNER`, `PORT`.

`make test-all` is also a good CI job for this repository: it catches broken templates before
anyone uses them in Backstage.

## Install in Backstage

1. Push this folder to a repository Backstage can read.
2. Register `catalog-info.yaml` (a `Location` pointing at all the templates), either in the UI
   (*Create… → Register existing component*) or in `app-config.yaml`:

   ```yaml
   catalog:
     locations:
       - type: url
         target: https://github.com/<org>/<repo>/blob/main/templates/catalog-info.yaml
         rules:
           - allow: [Template, Location]
   ```

3. Make sure the scaffolder can publish: `integrations.github` / `integrations.gitlab` in
   `app-config.yaml` with tokens that can create repositories, and the GitHub / GitLab scaffolder
   modules installed (`@backstage/plugin-scaffolder-backend-module-github` / `-gitlab`).
4. Optional: edit `allowedHosts` in each `template.yaml` (add self-hosted GitLab or GitHub Enterprise
   hosts). The steps pick GitHub or GitLab by checking whether the host contains `github` / `gitlab`.

## Placeholders to adjust

- `spec.owner: platform-team` in each `template.yaml`: set it to your platform team's group. `tenant-onboarding` also sets it as the owner of each tenant, in its `fetch` step.
- `mirkoszy/castorx-tenants` in `tenant-onboarding/template.yaml`: the tenant registry repository.
- `node-service` ships without `package-lock.json`. Generated repos create one on the first `npm install`; commit it.
