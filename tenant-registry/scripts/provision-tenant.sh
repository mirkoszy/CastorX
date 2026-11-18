#!/usr/bin/env bash
# Creates a tenant's GCP project and installs Backstage in it, using the tenant's service account.
# Safe to re-run: each step reuses what already exists, and re-running deploys IMAGE.
#
#   provision-tenant.sh             provision
#   provision-tenant.sh --validate  only check the inputs
#
# Inputs come from the environment because they originate from a form: never interpolate them
# into the workflow's shell code.
set -euo pipefail

SERVICE=backstage
SQL_INSTANCE=backstage
SQL_USER=backstage
SQL_TIER=${SQL_TIER:-db-g1-small}
RECORD_ROOT=${RECORD_ROOT:-tenants}

fail() { echo "error: $*" >&2; exit 1; }

check() { # name value regex
  [[ $2 =~ $3 ]] || fail "$1 is invalid: '$2'"
}

validate_inputs() {
  check TENANT "${TENANT:-}" '^[a-z][a-z0-9-]{1,61}[a-z0-9]$'
  check REPOSITORY_URL "${REPOSITORY_URL:-}" '^https://github\.com/[A-Za-z0-9-]+/[A-Za-z0-9._-]+$'
  check GCP_PARENT "${GCP_PARENT:-}" '^(organizations|folders)/[0-9]+$'
  check GCP_BILLING_ACCOUNT "${GCP_BILLING_ACCOUNT:-}" '^[0-9A-F]{6}-[0-9A-F]{6}-[0-9A-F]{6}$'
  check GCP_REGION "${GCP_REGION:-}" '^[a-z]+-[a-z]+[0-9]+$'
  check IAP_MEMBERS "${IAP_MEMBERS:-}" '^(user|group):[^,[:space:]]+@[^,[:space:]]+(,(user|group):[^,[:space:]]+@[^,[:space:]]+)*$'
  check IMAGE "${IMAGE:-}" '^[a-z0-9.-]+(:[0-9]+)?(/[a-z0-9._-]+)+:[A-Za-z0-9._-]+$'
}

# Project IDs are limited to 30 characters and global. The hash keeps long names unique and repeatable.
project_id_for() {
  local hash
  hash=$(printf '%s' "$1" | sha256sum | cut -c1-6)
  echo "bs-${1:0:20}-${hash}"
}

# New service accounts and service agents take a moment to become visible to IAM.
retry() {
  local attempt
  for attempt in 1 2 3 4 5 6; do
    if "$@"; then return 0; fi
    echo "Attempt $attempt failed; retrying in $((attempt * 10))s..." >&2
    sleep "${RETRY_DELAY:-$((attempt * 10))}"
  done
  "$@"
}

ensure_project() {
  if gcloud projects describe "$PROJECT_ID" >/dev/null 2>&1; then
    echo "Project $PROJECT_ID exists."
  elif [[ $GCP_PARENT == organizations/* ]]; then
    gcloud projects create "$PROJECT_ID" --name="$PROJECT_ID" --organization="${GCP_PARENT#*/}"
  else
    gcloud projects create "$PROJECT_ID" --name="$PROJECT_ID" --folder="${GCP_PARENT#*/}"
  fi
  gcloud billing projects link "$PROJECT_ID" --billing-account="$GCP_BILLING_ACCOUNT"
  gcloud services enable --project="$PROJECT_ID" \
    artifactregistry.googleapis.com \
    iap.googleapis.com \
    iam.googleapis.com \
    run.googleapis.com \
    secretmanager.googleapis.com \
    sqladmin.googleapis.com
  PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
  [[ -n $PROJECT_NUMBER ]] || fail "could not read the number of project $PROJECT_ID"
  export CLOUDSDK_CORE_PROJECT=$PROJECT_ID
}

ensure_runtime_account() {
  RUNTIME_SA="backstage-runtime@${PROJECT_ID}.iam.gserviceaccount.com"
  if ! gcloud iam service-accounts describe "$RUNTIME_SA" >/dev/null 2>&1; then
    gcloud iam service-accounts create backstage-runtime --display-name='Backstage on Cloud Run'
  fi
  retry gcloud projects add-iam-policy-binding "$PROJECT_ID" --condition=None --quiet \
    --member="serviceAccount:$RUNTIME_SA" --role=roles/cloudsql.client >/dev/null
}

# Generates the value once, so a re-run keeps existing passwords and keys.
ensure_generated_secret() {
  local name=$1
  if ! gcloud secrets describe "$name" >/dev/null 2>&1; then
    gcloud secrets create "$name" --replication-policy=automatic
    openssl rand -hex 32 | tr -d '\n' | gcloud secrets versions add "$name" --data-file=-
  fi
  retry gcloud secrets add-iam-policy-binding "$name" --condition=None \
    --member="serviceAccount:$RUNTIME_SA" --role=roles/secretmanager.secretAccessor >/dev/null
}

ensure_database() {
  if gcloud sql instances describe "$SQL_INSTANCE" >/dev/null 2>&1; then
    echo "Cloud SQL instance $SQL_INSTANCE exists."
  else
    echo "Creating Cloud SQL instance, which usually takes several minutes..."
    gcloud sql instances create "$SQL_INSTANCE" \
      --database-version=POSTGRES_17 \
      --edition=ENTERPRISE \
      --tier="$SQL_TIER" \
      --region="$GCP_REGION" \
      --storage-auto-increase \
      --backup-start-time=03:00 \
      --deletion-protection
  fi

  local password
  password=$(gcloud secrets versions access latest --secret=postgres-password)
  if gcloud sql users list --instance="$SQL_INSTANCE" --format='value(name)' | grep -qx "$SQL_USER"; then
    gcloud sql users set-password "$SQL_USER" --instance="$SQL_INSTANCE" --password="$password"
  else
    gcloud sql users create "$SQL_USER" --instance="$SQL_INSTANCE" --password="$password"
  fi
}

# Each tenant gets its own copy, so Cloud Run needs no access outside the tenant's organization.
copy_image() {
  local registry="${GCP_REGION}-docker.pkg.dev"
  if ! gcloud artifacts repositories describe backstage --location="$GCP_REGION" >/dev/null 2>&1; then
    gcloud artifacts repositories create backstage --location="$GCP_REGION" --repository-format=docker
  fi
  TENANT_IMAGE="${registry}/${PROJECT_ID}/backstage/backstage:${IMAGE##*:}"
  gcloud auth print-access-token | crane auth login "$registry" -u oauth2accesstoken --password-stdin
  crane copy "$IMAGE" "$TENANT_IMAGE"
}

deploy_service() {
  # Cloud Run's URL and IAP's token audience can both be derived before the first deploy.
  SERVICE_URL="https://${SERVICE}-${PROJECT_NUMBER}.${GCP_REGION}.run.app"
  local audience="/projects/${PROJECT_NUMBER}/locations/${GCP_REGION}/services/${SERVICE}"
  local connection="${PROJECT_ID}:${GCP_REGION}:${SQL_INSTANCE}"

  # Backstage runs catalog processing in the background, so it needs an always-on CPU.
  gcloud run deploy "$SERVICE" \
    --image="$TENANT_IMAGE" \
    --region="$GCP_REGION" \
    --service-account="$RUNTIME_SA" \
    --no-allow-unauthenticated \
    --iap \
    --port=7007 \
    --cpu=1 \
    --memory=2Gi \
    --min-instances=1 \
    --max-instances=2 \
    --no-cpu-throttling \
    --cpu-boost \
    --add-cloudsql-instances="$connection" \
    --set-env-vars="APP_BASE_URL=${SERVICE_URL},IAP_AUDIENCE=${audience},POSTGRES_HOST=/cloudsql/${connection},POSTGRES_USER=${SQL_USER}" \
    --set-secrets=POSTGRES_PASSWORD=postgres-password:latest,BACKEND_SECRET=backend-secret:latest \
    --quiet
}

grant_access() {
  gcloud beta services identity create --service=iap.googleapis.com >/dev/null
  retry gcloud run services add-iam-policy-binding "$SERVICE" --region="$GCP_REGION" --condition=None \
    --member="serviceAccount:service-${PROJECT_NUMBER}@gcp-sa-iap.iam.gserviceaccount.com" \
    --role=roles/run.invoker >/dev/null

  local member members
  IFS=, read -ra members <<<"$IAP_MEMBERS"
  for member in "${members[@]}"; do
    retry gcloud iap web add-iam-policy-binding --condition=None \
      --member="$member" --role=roles/iap.httpsResourceAccessor \
      --region="$GCP_REGION" --resource-type=cloud-run --service="$SERVICE" >/dev/null
  done
}

write_record() {
  local dir="${RECORD_ROOT}/${TENANT}"
  mkdir -p "$dir"
  cat >"${dir}/catalog-info.yaml" <<RECORD
apiVersion: backstage.io/v1alpha1
kind: Resource
metadata:
  name: ${TENANT}
  description: Tenant ${TENANT}
  tags: [tenant]
  annotations:
    github.com/project-slug: ${REPOSITORY_URL#https://github.com/}
    castorx.io/gcp-project: ${PROJECT_ID}
    castorx.io/gcp-region: ${GCP_REGION}
  links:
    - url: ${REPOSITORY_URL}
      title: Repository
    - url: ${SERVICE_URL}
      title: Tenant Backstage
spec:
  type: tenant
  owner: platform-team
RECORD
}

main() {
  validate_inputs
  PROJECT_ID=$(project_id_for "$TENANT")
  if [[ ${1:-} == --validate ]]; then
    echo "Inputs are valid. Project ID: $PROJECT_ID"
    return
  fi

  ensure_project
  ensure_runtime_account
  ensure_generated_secret postgres-password
  ensure_generated_secret backend-secret
  ensure_database
  copy_image
  deploy_service
  grant_access
  write_record

  echo "Tenant Backstage: $SERVICE_URL"
  if [[ -n ${GITHUB_STEP_SUMMARY:-} ]]; then
    {
      echo "### Tenant \`$TENANT\` is ready"
      echo "- Backstage: $SERVICE_URL"
      echo "- GCP project: \`$PROJECT_ID\`"
    } >>"$GITHUB_STEP_SUMMARY"
  fi
}

main "$@"
