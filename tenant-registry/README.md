# Tenant registry

Copy this folder's contents to the root of a **private** repository. Its workflow logs and the
`tenants/` records name your customers.

Running the `tenant-onboarding` Backstage template starts the `Provision tenant` workflow, which:

1. Creates a GCP project in the tenant's organization or folder and links their billing account.
2. Creates a Cloud SQL PostgreSQL instance and generates the secrets, stored in Secret Manager.
3. Copies the Backstage image into the project and deploys it to Cloud Run behind IAP.
4. Grants the listed people access, then commits `tenants/<tenant>/catalog-info.yaml`.

Re-run the workflow to retry a failed run or deploy a newer image. Existing resources and passwords are kept.

## Setup

1. Set the repository variable `BACKSTAGE_IMAGE` to a pinned image, for example
   `ghcr.io/mirkoszy/castorx-backstage:<commit sha>`. The package must be public, or the workflow can't pull it.
2. Give Backstage's GitHub token permission to run workflows and administer this repository.
3. Allow the workflow to push to `main`. If `main` is protected, the final record step fails.
4. Point the template at this repository in `templates/tenant-onboarding/template.yaml`.

## What each tenant must prepare

The tenant needs a Google Cloud organization, because IAP's automated setup only supports users inside one.
Everyone granted access must belong to that organization.

Their service account needs:

| Role | Granted on |
|---|---|
| `roles/resourcemanager.projectCreator` | The organization or folder |
| `roles/billing.user` | The billing account |

The creator of a project becomes its owner, which covers everything inside it. The project holding the
service account must have the Cloud Resource Manager, Cloud Billing and Service Usage APIs enabled.

Organization policies can block this setup. Check these first: `sql.restrictPublicIp`,
`gcp.resourceLocations` and `iam.allowedPolicyMemberDomains`.

### Without a key (recommended)

The tenant creates a Workload Identity Federation provider that trusts only this repository:

```bash
gcloud iam workload-identity-pools create castorx --location=global
gcloud iam workload-identity-pools providers create-oidc github --location=global \
  --workload-identity-pool=castorx \
  --issuer-uri=https://token.actions.githubusercontent.com \
  --attribute-mapping=google.subject=assertion.sub,attribute.repository=assertion.repository \
  --attribute-condition="assertion.repository == '<org>/<this-repo>'"
gcloud iam service-accounts add-iam-policy-binding <service-account-email> \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/<project-number>/locations/global/workloadIdentityPools/castorx/attribute.repository/<org>/<this-repo>"
```

They then enter the service account email and the provider's full name in the form.

### With a key

The key is stored as the `GCP_SA_KEY` secret in the tenant's GitHub environment. It can create projects
and spend on the tenant's billing account, so anyone who can change this repository's workflows on `main`
can use it. Ask tenants to delete the key after onboarding unless you need it for upgrades.

## Removing a tenant

Disable the Cloud SQL deletion protection, then delete the project in the tenant's organization.
Remove the `tenant-<tenant>` environment and the `tenants/<tenant>` record here.
