<template>
  <CommonDialog
    v-model:open="showReceiveDialog"
    fullscreen="none"
    :title="title"
    :show-back-button="step !== 1"
    @back="step--"
    @fully-closed="step = 1"
  >
    <div>
      <div v-if="step === 1">
        <WizardProjectSelector
          :is-sender="false"
          :show-new-project="false"
          :url-parse-error="urlParseError"
          @next="selectProject"
          @search-text-update="updateSearchText"
        />
      </div>
      <div v-if="step === 2 && selectedProject && selectedAccountId">
        <div>
          <WizardModelSelector
            :project="selectedProject"
            :account-id="selectedAccountId"
            :show-new-model="false"
            @next="selectModel"
          />
        </div>
      </div>
      <div v-if="step === 3">
        <WizardVersionSelector
          v-if="selectedProject && selectedModel"
          :account-id="selectedAccountId"
          :project-id="selectedProject.id"
          :model-id="selectedModel.id"
          :selected-version-id="urlParsedVersionId"
          :workspace-slug="selectedWorkspace?.slug"
          :from-wizard="true"
          @next="selectVersionAndAddModel"
          @update:settings="handleUpdateSettings"
        />
      </div>
    </div>
    <div v-if="urlParseError" class="p-2 text-danger">{{ urlParseError }}</div>
  </CommonDialog>
</template>
<script setup lang="ts">
import { storeToRefs } from 'pinia'
import type {
  ModelListModelItemFragment,
  ProjectListProjectItemFragment,
  VersionListItemFragment,
  WorkspaceListWorkspaceItemFragment
} from '~/lib/common/generated/gql/graphql'
import { useHostAppStore } from '~/store/hostApp'
import { useAccountStore } from '~/store/accounts'
import { ReceiverModelCard } from '~/lib/models/card/receiver'
import { useMixpanel } from '~/lib/core/composables/mixpanel'
import { useAddByUrl } from '~/lib/core/composables/addByUrl'
import { getSlugFromHostAppNameAndVersion } from '~/lib/common/helpers/hostAppSlug'
import type { CardSetting } from '~/lib/models/card/setting'

const { trackEvent } = useMixpanel()

const showReceiveDialog = defineModel<boolean>('open', { default: false })

const emit = defineEmits(['close'])

const step = ref(1)

// Clears data if going backwards in the wizard
watch(step, (newVal, oldVal) => {
  if (newVal > oldVal) return // exit fast on forward
  if (newVal === 1) {
    selectedProject.value = undefined
    selectedModel.value = undefined
  }
  if (newVal === 2) selectedModel.value = undefined
})

const accountStore = useAccountStore()
const { activeAccount } = storeToRefs(accountStore)

const selectedAccountId = ref<string>(activeAccount.value?.accountInfo.id as string)
const selectedWorkspace = ref<WorkspaceListWorkspaceItemFragment>()
const selectedProject = ref<ProjectListProjectItemFragment>()
const selectedModel = ref<ModelListModelItemFragment>()
const receieveSettings = ref<CardSetting[] | undefined>(undefined)

const { tryParseUrl, urlParsedData, urlParseError } = useAddByUrl()
const updateSearchText = (text: string | undefined) => {
  urlParseError.value = undefined
  if (!text) return
  tryParseUrl(text, 'receiver')
}

const urlParsedVersionId = ref<string>()
watch(urlParsedData, (newVal) => {
  if (!newVal) return
  selectProject(newVal.account?.accountInfo.id, newVal.project)
  selectModel(newVal.model)
  if (newVal.version) urlParsedVersionId.value = newVal.version.id
})

watch(showReceiveDialog, (newVal) => {
  if (newVal) {
    urlParseError.value = undefined
  }
})

const selectProject = (
  accountId: string,
  project: ProjectListProjectItemFragment,
  workspace?: WorkspaceListWorkspaceItemFragment
) => {
  step.value++
  selectedAccountId.value = accountId
  selectedProject.value = project
  selectedWorkspace.value = workspace

  void trackEvent('DUI3 Action', { name: 'Load Wizard', step: 'project selected' })
}

const selectModel = (model: ModelListModelItemFragment) => {
  step.value++
  selectedModel.value = model
  void trackEvent('DUI3 Action', { name: 'Load Wizard', step: 'model selected' })
}

const title = computed(() => {
  if (step.value === 1) return 'Select project'
  if (step.value === 2) return 'Select model'
  if (step.value === 3) return 'Select version'
  return ''
})

const handleUpdateSettings = (settings: CardSetting[]) => {
  receieveSettings.value = settings
}

// accountId, serverUrl,  ModelListModelItemFragment, VersionListItemFragment
const selectVersionAndAddModel = async (
  version: VersionListItemFragment,
  latestVersion: VersionListItemFragment
) => {
  void trackEvent('DUI3 Action', {
    name: 'Load Wizard',
    step: 'version selected',
    hasSelectedLatestVersion: version.id === latestVersion.id
  })

  const existingModel = hostAppStore.models.find(
    (m) =>
      m.modelId === selectedModel.value?.id &&
      m.typeDiscriminator === 'ReceiverModelCard'
  ) as ReceiverModelCard

  if (existingModel) {
    emit('close')
    // Patch the existing model card with new versions!
    await hostAppStore.patchModel(existingModel.modelCardId, {
      selectedVersionId: version.id,
      selectedVersionSourceApp: version.sourceApplication,
      selectedVersionUserId: version.authorUser?.id,
      latestVersionId: latestVersion.id,
      latestVersionSourceApp: latestVersion.sourceApplication,
      latestVersionUserId: latestVersion.authorUser?.id
    })
    await hostAppStore.receiveModel(existingModel.modelCardId, 'Wizard')
    return
  }

  // We were tracking the source host app wrong before `getHostAppFromString`
  // i.e. we were having `Revit 2023` instead of `revit`
  const selectedVersionSourceApp = getSlugFromHostAppNameAndVersion(
    version.sourceApplication as string
  )
  const latestVersionSourceApp = getSlugFromHostAppNameAndVersion(
    latestVersion.sourceApplication as string
  )

  const modelCard = new ReceiverModelCard()
  modelCard.settings = receieveSettings.value
  modelCard.accountId = selectedAccountId.value
  modelCard.serverUrl = activeAccount.value.accountInfo.serverInfo.url

  modelCard.projectId = selectedProject.value?.id as string
  modelCard.modelId = selectedModel.value?.id as string
  modelCard.workspaceId = selectedProject.value?.workspace?.id as string
  modelCard.workspaceSlug = selectedProject?.value?.workspace?.slug as string

  modelCard.projectName = selectedProject.value?.name as string
  modelCard.modelName = selectedModel.value?.name as string

  modelCard.selectedVersionId = version.id
  modelCard.selectedVersionSourceApp = selectedVersionSourceApp
  modelCard.selectedVersionUserId = version.authorUser?.id as string

  modelCard.latestVersionId = latestVersion.id
  modelCard.latestVersionSourceApp = latestVersionSourceApp
  modelCard.latestVersionUserId = latestVersion.authorUser?.id as string

  modelCard.hasDismissedUpdateWarning = true
  modelCard.hasSelectedOldVersion = version.id !== latestVersion.id

  emit('close')
  await hostAppStore.addModel(modelCard)
  await hostAppStore.receiveModel(modelCard.modelCardId, 'Wizard')
}

const hostAppStore = useHostAppStore()
</script>
