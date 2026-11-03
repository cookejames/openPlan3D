# Deploying from GitHub Actions

`.github/workflows/deploy.yml` deploys `main` after the **Web checks** workflow passes on a push, and can be
run by hand from the Actions tab. It runs `firebase deploy --only apphosting,firestore,storage`: an App
Hosting rollout of the checked commit plus the Firestore rules/indexes and Storage rules.

It authenticates with Workload Identity Federation: GitHub's OIDC token is exchanged for short-lived
credentials of a deploy service account, so no key is stored in GitHub.

## One-time setup (project owner)

Run with `gcloud` signed in as a project owner:

```bash
PROJECT=openplan3d-db739
REPO=cookejames/openPlan3D
NUMBER=$(gcloud projects describe $PROJECT --format='value(projectNumber)')
SA=github-deploy@$PROJECT.iam.gserviceaccount.com

gcloud services enable iamcredentials.googleapis.com sts.googleapis.com --project $PROJECT

# Deploy service account and its roles.
gcloud iam service-accounts create github-deploy --project $PROJECT --display-name "GitHub Actions deploy"
for role in roles/firebaseapphosting.admin roles/firebaserules.admin roles/datastore.indexAdmin \
            roles/storage.admin roles/serviceusage.serviceUsageConsumer roles/firebase.viewer; do
  gcloud projects add-iam-policy-binding $PROJECT --member "serviceAccount:$SA" --role $role --condition None
done
# Rollouts run as the App Hosting compute account, so the deployer must be able to act as it.
gcloud iam service-accounts add-iam-policy-binding \
  firebase-app-hosting-compute@$PROJECT.iam.gserviceaccount.com \
  --project $PROJECT --member "serviceAccount:$SA" --role roles/iam.serviceAccountUser

# Identity pool and GitHub provider, limited to this repository's main branch.
gcloud iam workload-identity-pools create github --project $PROJECT --location global --display-name GitHub
gcloud iam workload-identity-pools providers create-oidc github --project $PROJECT --location global \
  --workload-identity-pool github --issuer-uri https://token.actions.githubusercontent.com \
  --attribute-mapping 'google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref' \
  --attribute-condition "assertion.repository == '$REPO' && assertion.ref == 'refs/heads/main'"
gcloud iam service-accounts add-iam-policy-binding $SA --project $PROJECT --role roles/iam.workloadIdentityUser \
  --member "principalSet://iam.googleapis.com/projects/$NUMBER/locations/global/workloadIdentityPools/github/attribute.repository/$REPO"

# Values for GitHub.
echo "GCP_WORKLOAD_IDENTITY_PROVIDER=projects/$NUMBER/locations/global/workloadIdentityPools/github/providers/github"
echo "GCP_DEPLOY_SERVICE_ACCOUNT=$SA"
```

Then in GitHub (Settings → Environments), create a `production` environment, limit it to the `main`
branch, and add the two printed values as environment **variables** (not secrets; neither is sensitive).
Optionally add required reviewers there to approve each deploy.

If a deploy fails with a permission error, the message names the missing permission; grant the role that
holds it to `github-deploy`.
