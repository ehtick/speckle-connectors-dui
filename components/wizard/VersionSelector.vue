<template>
  <div>
    <div class="space-y-2">
      <div
        v-if="isLimited && workspaceSlug"
        class="flex items-center justify-between bg-foundation rounded-md border border-outline-3 p-1 space-x-2 text-xs"
      >
        <div class="ml-1">Upgrade to load older versions.</div>
        <FormButton
          size="sm"
          @click="$openUrl(`${serverUrl}/settings/workspaces/${workspaceSlug}/billing`)"
        >
          Upgrade
        </FormButton>
      </div>
      <div v-if="hasReceiveSettings">
        <ModelSettings
          class="mb-2"
          expandable
          :settings="settings"
          :default-settings="(store.receiveSettings as unknown as CardSetting[])"
          @update:settings="updateSettings"
        ></ModelSettings>
        <hr />
      </div>

      <div v-if="latestVersion" class="grid grid-cols-2 gap-3 max-[275px]:grid-cols-1">
        <WizardListVersionCard
          v-for="(version, index) in versions"
          :key="version.id"
          :version="version"
          :index="index"
          :latest-version-id="latestVersion.id"
          :selected-version-id="selectedVersionId"
          :project-id="projectId"
          :from-wizard="fromWizard"
          :account-id="accountId"
          @click="$emit('next', version, latestVersion)"
        />
      </div>
      <CommonLoadingBar v-if="loading" loading />
      <FormButton
        color="outline"
        full-width
        :disabled="hasReachedEnd"
        @click="loadMore"
      >
        {{ hasReachedEnd ? 'No older versions' : 'Show older versions' }}
      </FormButton>
    </div>
  </div>
</template>
<script setup lang="ts">
import { useQuery } from '@vue/apollo-composable'
import { modelVersionsQuery } from '~/lib/graphql/mutationsAndQueries'
import type { VersionListItemFragment } from '~/lib/common/generated/gql/graphql'
import { useAccountStore } from '~/store/accounts'
import type { CardSetting } from '~/lib/models/card/setting'
import { useHostAppStore } from '~/store/hostApp'

const emit = defineEmits<{
  (
    e: 'next',
    version: VersionListItemFragment,
    latestVersion: VersionListItemFragment
  ): void
  (e: 'update:settings', settings: CardSetting[]): void
}>()

const props = defineProps<{
  accountId: string
  projectId: string
  modelId: string
  settings?: CardSetting[]
  selectedVersionId?: string
  workspaceSlug?: string
  fromWizard?: boolean
}>()

const store = useHostAppStore()
const accountStore = useAccountStore()
const serverUrl = computed(() => accountStore.activeAccount.accountInfo.serverInfo.url)

const hasReceiveSettings = computed(
  () => store.receiveSettings && store.receiveSettings.length > 0
)

const updateSettings = (settings: CardSetting[]) => {
  emit('update:settings', settings)
}

const {
  result: modelVersionResults,
  loading,
  fetchMore,
  refetch
} = useQuery(
  modelVersionsQuery,
  () => {
    const payload = {
      projectId: props.projectId,
      modelId: props.modelId,
      limit: 6,
      filter: props.selectedVersionId
        ? { priorityIds: [props.selectedVersionId] }
        : undefined
    }

    return payload
  },
  () => ({ clientId: props.accountId, fetchPolicy: 'cache-and-network' })
)

const versions = computed(() => modelVersionResults.value?.project.model.versions.items)

const isLimited = computed(
  () => versions.value?.filter((v) => v.referencedObject === null).length !== 0
)

const hasReachedEnd = ref(false)

const latestVersion = computed(() => {
  if (!versions.value) return
  const sorted = [...versions.value].sort(
    (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)
  )
  return sorted[0]
})

const loadMore = () => {
  fetchMore({
    variables: { cursor: modelVersionResults.value?.project.model.versions.cursor },
    updateQuery: (previousResult, { fetchMoreResult }) => {
      if (
        !fetchMoreResult ||
        fetchMoreResult.project.model.versions.items.length === 0
      ) {
        hasReachedEnd.value = true
        return previousResult
      }
      return {
        project: {
          id: previousResult.project.id,
          __typename: previousResult.project.__typename,
          model: {
            id: previousResult.project.model.id,
            __typename: previousResult.project.model.__typename,
            versions: {
              __typename: previousResult.project.model.versions.__typename,
              totalCount: previousResult.project.model.versions.totalCount,
              cursor: fetchMoreResult?.project.model.versions.cursor,
              items: [
                ...previousResult.project.model.versions.items,
                ...fetchMoreResult.project.model.versions.items
              ]
            }
          }
        }
      }
    }
  })
}

onMounted(() => {
  refetch()
})
</script>
