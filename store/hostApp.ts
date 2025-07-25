import type {
  DocumentInfo,
  DocumentModelStore
} from '~/lib/bindings/definitions/IBasicConnectorBinding'
import type { IModelCard, ModelCardProgress } from '~/lib/models/card'
import { useMixpanel } from '~/lib/core/composables/mixpanel'
import type { IReceiverModelCard } from '~/lib/models/card/receiver'
import type {
  IDirectSelectionSendFilter,
  ISendFilter,
  ISendFilterSelectItem,
  ISenderModelCard,
  RevitViewsSendFilter,
  SendFilterSelect
} from '~/lib/models/card/send'
import type { ToastNotification } from '@speckle/ui-components'
import type { Nullable } from '@speckle/shared'
import type { HostAppError } from '~/lib/bridge/errorHandler'
import type { ConversionResult } from '~/lib/conversions/conversionResult'
import { defineStore } from 'pinia'
import type { CardSetting } from '~/lib/models/card/setting'
import type { DUIAccount } from '~/store/accounts'
import { useAccountStore } from '~/store/accounts'
import {
  useUpdateConnector,
  type Version
} from '~/lib/core/composables/updateConnector'
import { provideApolloClient, useMutation } from '@vue/apollo-composable'
import { createVersionMutation } from '~/lib/graphql/mutationsAndQueries'

export type ProjectModelGroup = {
  projectId: string
  accountId: string
  serverUrl: string
  senders: ISenderModelCard[]
  receivers: IReceiverModelCard[]
}

export const useHostAppStore = defineStore('hostAppStore', () => {
  const app = useNuxtApp()
  const { trackEvent } = useMixpanel()
  const { $openUrl } = useNuxtApp()
  const accountsStore = useAccountStore()
  const { checkUpdate } = useUpdateConnector()

  const isDistributedBySpeckle = ref<boolean>(true)
  const latestAvailableVersion = ref<Version | null>(null)

  const currentNotification = ref<Nullable<ToastNotification>>(null)
  const showErrorDialog = ref<boolean>(false)
  const hostAppError = ref<Nullable<HostAppError>>(null)

  const hostAppName = ref<string>()
  const hostAppVersion = ref<string>()
  const connectorVersion = ref<string>()
  const documentInfo = ref<DocumentInfo>()
  const documentModelStore = ref<DocumentModelStore>({ models: [] })

  const availableViews = ref<string[]>() // TODO: later we can align views with -> const revitAvailableViews = ref<ISendFilterSelectItem[]>()
  const navisworksAvailableSavedSets = ref<ISendFilterSelectItem[]>()

  // Different host apps can have different kind of ISendFilterSelect send filters, and we collect them here to generalize the component we use in `ListSelect`
  const availableSelectSendFilters = ref<Record<string, SendFilterSelect>>({})

  const dismissNotification = () => {
    currentNotification.value = null
  }

  const setNotification = (notification: Nullable<ToastNotification>) => {
    currentNotification.value = notification
  }

  const setLatestAvailableVersion = (version: Nullable<Version>) => {
    latestAvailableVersion.value = version
  }

  function downloadLatestVersion() {
    $openUrl(latestAvailableVersion.value?.Url as string)
  }

  const isConnectorUpToDate = computed(
    () => connectorVersion.value === latestAvailableVersion.value?.Number
  )

  const setHostAppError = (error: Nullable<HostAppError>) => {
    hostAppError.value = error
  }

  const setIsDistributedBySpeckle = (val: boolean) => {
    isDistributedBySpeckle.value = val
  }

  /**
   * Model Card Operations
   */

  /**
   * A list of all models currently in the file, grouped by the project they are part of.
   */
  const projectModelGroups = computed(() => {
    const projectModelGroups: ProjectModelGroup[] = []
    for (const model of documentModelStore.value.models) {
      let project = projectModelGroups.find((p) => p.projectId === model.projectId)
      if (!project) {
        project = {
          projectId: model.projectId,
          accountId: model.accountId,
          serverUrl: model.serverUrl,
          senders: [],
          receivers: []
        }
        projectModelGroups.push(project)
      }
      if (model.typeDiscriminator.toLowerCase().includes('sender'))
        project.senders.push(model as ISenderModelCard)
      if (model.typeDiscriminator.toLowerCase().includes('receiver'))
        project.receivers.push(model as IReceiverModelCard)
    }
    return projectModelGroups
  })

  const models = computed(() => {
    return documentModelStore.value.models
  })

  /**
   * Adds a new model and persists it to the host app file.
   * @param model
   */
  const addModel = async (model: IModelCard) => {
    await app.$baseBinding.addModel(model)
    documentModelStore.value.models.push(model)
  }

  /**
   * Updates a model's provided properties and persists the changes in the host application.
   * @param modelCardId The model card id (NOT the model id).
   * @param properties Properties to update.
   * @param updateInHostApp Whether to sync the state to the host app. Defaults to true.
   */
  const patchModel = async (
    modelCardId: string,
    properties: Record<string, unknown>,
    updateInHostApp: boolean = true
  ) => {
    const modelIndex = documentModelStore.value.models.findIndex(
      (m) => m.modelCardId === modelCardId
    )

    documentModelStore.value.models[modelIndex] = {
      ...documentModelStore.value.models[modelIndex],
      ...properties
    }

    if (!updateInHostApp) return
    await app.$baseBinding.updateModel(documentModelStore.value.models[modelIndex])
  }

  /**
   * Removes a model from the store and the host app file.
   * @param model
   */
  const removeModel = async (model: IModelCard) => {
    await app.$baseBinding.removeModel(model)
    documentModelStore.value.models = documentModelStore.value.models.filter(
      (item) => item.modelCardId !== model.modelCardId
    )

    void trackEvent(
      'DUI3 Action',
      { name: 'Remove Model Card', type: model.typeDiscriminator },
      model.accountId
    )
  }

  const removeAccountModels = async (accountId: string) => {
    const modelsToRemove = documentModelStore.value.models.filter(
      (item) => item.accountId === accountId
    )
    documentModelStore.value.models = documentModelStore.value.models.filter(
      (item) => item.accountId !== accountId
    )

    if (modelsToRemove.length !== 0) {
      await app.$baseBinding.removeModels(modelsToRemove)
    }
  }

  const removeProjectModels = async (projectId: string) => {
    const modelsToRemove = documentModelStore.value.models.filter(
      (item) => item.projectId === projectId
    )
    if (modelsToRemove.length !== 0) {
      await app.$baseBinding.removeModels(modelsToRemove)
    }
  }

  const sendSettings = ref<CardSetting[]>()
  const receiveSettings = ref<CardSetting[]>()

  /**
   * Send filters
   */

  /**
   * The host app's available send filters.
   */
  const sendFilters = ref<ISendFilter[]>()

  /**
   * Selection filter shortcut - use it as a default if possible.
   */
  const selectionFilter = computed(
    () => sendFilters.value?.find((f) => f.name === 'Selection') as ISendFilter
  )

  // Used on Archicad so far since send operation blocks the UI thread.
  app.$sendBinding?.on('triggerCancel', (modelCardId: string) => {
    const model = documentModelStore.value.models.find(
      (m) => m.modelCardId === modelCardId
    ) as ISenderModelCard
    model.progress = undefined
    model.error = undefined
    void trackEvent('DUI3 Action', { name: 'Send Cancel' }, model.accountId)
    model.latestCreatedVersionId = undefined
  })

  app.$sendBinding?.on(
    'setIdMap',
    async ({ modelCardId, idMap, newSelectedObjectIds }) => {
      const modelCard = models.value.find(
        (card) => card.modelCardId === modelCardId
      ) as ISenderModelCard
      if (!modelCard) return

      const newFilter = {
        ...modelCard.sendFilter,
        selectedObjectIds: newSelectedObjectIds,
        idMap
      }

      // https://linear.app/speckle/issue/CNX-1213/revit-when-moving-between-documents-cards-can-get-lost-between-them
      await patchModel(modelCardId, { sendFilter: newFilter }) // we do not necessarily need to updateModel in revit bc we already do it on .NET - otherwise it is leading cleanup on document store bc of deferred action when we switched to the another doc
    }
  )

  app.$selectionBinding?.on('setSelection', (selInfo) => {
    const modelCards = models.value.filter(
      (m) =>
        m.typeDiscriminator.toLowerCase().includes('sender') &&
        (m as ISenderModelCard).sendFilter?.name === 'Selection'
    ) as ISenderModelCard[]

    for (const model of modelCards) {
      const filter = model.sendFilter as IDirectSelectionSendFilter
      if (selInfo.selectedObjectIds.length === 0) {
        filter.expired = false
        continue
      }
      const a1 = filter.selectedObjectIds.sort().join()
      const a2 = selInfo.selectedObjectIds.sort().join()

      filter.expired = a1 !== a2
      // filter.expired =
      //   filter.selectedObjectIds.filter((id) => !selInfo.selectedObjectIds.includes(id))
      //     .length !== 0
    }
  })

  /**
   * It is needed for connectors that send data with REST API on host app side but do not have graphql logic to create version.
   * Currently it is the case with Vectorworks only which asked by a extarnal collaborator.
   */
  app.$sendBinding?.on('triggerCreateVersion', async (args) => {
    const accountStore = useAccountStore()
    const account = accountStore.accounts.find(
      (acc) => acc.accountInfo.id === args.accountId
    )
    try {
      const createVersion = provideApolloClient((account as DUIAccount).client)(() =>
        useMutation(createVersionMutation)
      )
      await createVersion.mutate({
        input: {
          modelId: args.modelId,
          objectId: args.referencedObjectId,
          sourceApplication: args.sourceApplication,
          projectId: args.projectId
        }
      })
    } catch (err) {
      console.error(`triggerCreateVersion is failed: ${err}`)
    }
  })

  /**
   * Everything filter shortcut - do not use it as a default.
   */
  const everythingFilter = computed(
    () => sendFilters.value?.find((f) => f.name === 'Everything') as ISendFilter
  )

  /**
   * Subscribe to notifications about send filters.
   */
  app.$sendBinding?.on('refreshSendFilters', () => void refreshSendFilters())

  /**
   * Send functionality
   */

  /**
   * Tells the host app to start sending a specific model card. This will reach inside the host application.
   * @param modelId
   */
  const sendModel = (modelCardId: string, actionSource: string) => {
    const model = documentModelStore.value.models.find(
      (m) => m.modelCardId === modelCardId
    ) as ISenderModelCard
    if (model.expired) {
      // user sends via "Update" button
      void trackEvent(
        'Send',
        {
          expired: true,
          actionSource: actionSource.toLowerCase(),
          // eslint-disable-next-line camelcase
          workspace_id: model.workspaceId
        },
        model.accountId
      )
    } else {
      void trackEvent(
        'Send',
        {
          expired: false,
          actionSource: actionSource.toLowerCase(),
          // eslint-disable-next-line camelcase
          workspace_id: model.workspaceId
        },
        model.accountId
      )
    }
    model.latestCreatedVersionId = undefined
    model.error = undefined
    model.progress = { status: 'Starting to send...' }
    model.expired = false
    model.report = undefined
    // You should stop asking why if you saw anything related autocad..
    // It solves the press "escape" issue.
    // Because probably we don't give enough time to acad complete it's previos task and it stucks.
    const shittyHostApps = ['autocad']
    if (shittyHostApps.includes(hostAppName.value as string)) {
      setTimeout(() => {
        void app.$sendBinding.send(modelCardId)
      }, 500) // I prefer to sacrifice 500ms
    } else {
      void app.$sendBinding.send(modelCardId)
    }
  }

  /**
   * Cancels a model card's ongoing send operation. This will reach inside the host application.
   * @param modelId
   */
  const sendModelCancel = async (modelCardId: string) => {
    const model = documentModelStore.value.models.find(
      (m) => m.modelCardId === modelCardId
    ) as ISenderModelCard
    await app.$sendBinding.cancelSend(modelCardId)
    model.progress = undefined
    model.error = undefined
    void trackEvent('DUI3 Action', { name: 'Send Cancel' }, model.accountId)
    model.latestCreatedVersionId = undefined
  }

  app.$sendBinding?.on('setModelsExpired', (modelCardIds) => {
    documentModelStore.value.models
      .filter((m) => modelCardIds.includes(m.modelCardId))
      .forEach((model: ISenderModelCard) => {
        model.latestCreatedVersionId = undefined
        model.error = undefined
        model.expired = true
      })
  })

  const setModelSendResult = (args: {
    modelCardId: string
    versionId: string
    sendConversionResults: ConversionResult[]
  }) => {
    const model = documentModelStore.value.models.find(
      (m) => m.modelCardId === args.modelCardId
    ) as ISenderModelCard
    model.latestCreatedVersionId = args.versionId
    model.report = args.sendConversionResults
    model.progress = undefined
  }

  app.$sendBinding?.on('setModelSendResult', setModelSendResult)

  /// RECEIVE STUFF
  const receiveModel = async (modelCardId: string, actionSource: string) => {
    const model = documentModelStore.value.models.find(
      (m) => m.modelCardId === modelCardId
    ) as IReceiverModelCard

    const account = accountsStore.accounts.find(
      (a) => a.accountInfo.id === model.accountId
    )

    void trackEvent(
      'Receive',
      {
        expired: model.expired,
        sourceHostApp: model.selectedVersionSourceApp,
        isMultiplayer: model.selectedVersionUserId !== account?.accountInfo.userInfo.id,
        actionSource: actionSource.toLowerCase(),
        // eslint-disable-next-line camelcase
        workspace_id: model.workspaceId
      },
      model.accountId
    )

    model.report = undefined
    model.error = undefined
    model.displayReceiveComplete = false
    model.hasDismissedUpdateWarning = true
    model.progress = { status: 'Starting to receive...' }

    // You should stop asking why if you saw anything related autocad..
    // It solves the press "escape" issue.
    // Because probably we don't give enough time to acad complete it's previos task and it stucks.
    const shittyHostApps = ['autocad']
    if (shittyHostApps.includes(hostAppName.value as string)) {
      setTimeout(async () => {
        await app.$receiveBinding.receive(modelCardId)
      }, 500) // I prefer to sacrifice 500ms
    } else {
      await app.$receiveBinding.receive(modelCardId)
    }
  }

  const receiveModelCancel = async (modelCardId: string) => {
    const model = documentModelStore.value.models.find(
      (m) => m.modelCardId === modelCardId
    ) as IReceiverModelCard
    await app.$receiveBinding.cancelReceive(modelCardId)
    void trackEvent('DUI3 Action', { name: 'Receive Cancel' }, model.accountId)
    model.progress = undefined
  }

  const setModelReceiveResult = async (args: {
    modelCardId: string
    bakedObjectIds: string[]
    conversionResults: ConversionResult[]
  }) => {
    const model = documentModelStore.value.models.find(
      (m) => m.modelCardId === args.modelCardId
    ) as IReceiverModelCard

    model.progress = undefined
    model.displayReceiveComplete = true
    model.bakedObjectIds = args.bakedObjectIds
    model.report = args.conversionResults

    // NOTE: going through this method to ensure state sync between FE and BE. It's because of a very weird rhino bug on first receives, ask dim and he will cry
    // TODO: check if it's still needed - we can store the bakedobject ids straigth into the receive ops in .net. Is the above reproducible?
    await patchModel(model.modelCardId, {
      bakedObjectIds: args.bakedObjectIds
    })
  }

  app.$receiveBinding?.on('setModelReceiveResult', setModelReceiveResult)

  // GENERIC STUFF
  const handleModelProgressEvents = (args: {
    modelCardId: string
    progress?: ModelCardProgress
  }) => {
    const model = documentModelStore.value.models.find(
      (m) => m.modelCardId === args.modelCardId
    ) as IModelCard
    model.progress = args.progress
  }

  const setModelError = (args: {
    modelCardId: string
    error: string | { errorMessage: string; dismissible?: boolean }
  }) => {
    const model = documentModelStore.value.models.find(
      (m) => m.modelCardId === args.modelCardId
    ) as IModelCard
    model.progress = undefined
    if (typeof args.error === 'string') {
      model.error = { errorMessage: args.error as string, dismissible: true }
    } else {
      model.error = args.error as {
        errorMessage: string
        dismissible: boolean
      }
    }
  }

  // NOTE: all bindings that need to send these model events should register.
  // EG, new binding "mapper binding" wants to send errors to the model card should
  // be registed here. Why? Each binding gets its own "bridge" parent in .NET, which
  // is hoisted as a separate global js object.
  app.$sendBinding?.on('setModelProgress', handleModelProgressEvents)
  app.$receiveBinding?.on('setModelProgress', handleModelProgressEvents)

  app.$baseBinding?.on('setGlobalNotification', setNotification)
  app.$sendBinding?.on('setGlobalNotification', setNotification)
  app.$receiveBinding?.on('setGlobalNotification', setNotification)
  app.$configBinding?.on('setGlobalNotification', setNotification)
  app.$accountBinding?.on('setGlobalNotification', setNotification)
  app.$selectionBinding?.on('setGlobalNotification', setNotification)
  app.$testBindings?.on('setGlobalNotification', setNotification)

  // Dummy binding to communicate with proper bridge for top level exceptions
  app.$topLevelExceptionHandlerBinding?.on('setGlobalNotification', setNotification)

  app.$sendBinding?.on('setModelError', setModelError)
  app.$receiveBinding?.on('setModelError', setModelError)
  app.$baseBinding?.on('setModelError', setModelError)

  /**
   * Used internally in this store store only for initialisation.
   */
  const getHostAppName = async () =>
    (hostAppName.value = await app.$baseBinding.getSourceApplicationName())

  const getHostAppVersion = async () =>
    (hostAppVersion.value = await app.$baseBinding.getSourceApplicationVersion())

  const getConnectorVersion = async () => {
    connectorVersion.value = await app.$baseBinding.getConnectorVersion()
    // Checks whether new version available for the connector or not and throws a toast notification if any.
    if (app.$isRunningOnConnector) {
      await checkUpdate()
    }
  }

  /**
   * Used internally in this store store only for initialisation. Refreshed the document info from the host app. Should be called on document changed events.
   */
  const refreshDocumentInfo = async () =>
    (documentInfo.value = await app.$baseBinding.getDocumentInfo())

  /**
   * Used internally in this store store only for initialisation. Refreshes available model cards from the host app. Should be called on document changed events.
   */
  const refreshDocumentModelStore = async () =>
    (documentModelStore.value = await app.$baseBinding.getDocumentState())

  /**
   * Sources the available send filters from the app. This is useful in case of host app layer changes, etc.
   */
  const refreshSendFilters = async () => {
    sendFilters.value = await app.$sendBinding?.getSendFilters()
    const revitViews = sendFilters.value.find(
      (f) => f.id === 'revitViews'
    ) as RevitViewsSendFilter
    if (revitViews) {
      availableViews.value = revitViews.availableViews
    }

    const selectSendFilters = sendFilters.value.filter(
      (f) => f.type === 'Select'
    ) as SendFilterSelect[]
    if (selectSendFilters.length !== 0) {
      selectSendFilters.forEach((selectSendFilter) => {
        const id = selectSendFilter.id
        availableSelectSendFilters.value[id] = selectSendFilter
      })
    }

    const navisworksSavedSetsFromSendFilters = sendFilters.value.find(
      (f) => f.id === 'navisworksSavedSets'
    ) as SendFilterSelect
    if (navisworksSavedSetsFromSendFilters) {
      navisworksAvailableSavedSets.value = navisworksSavedSetsFromSendFilters.items
    }

    tryToUpgradeSelectSendFilters() // in rhino we trigger refresh send filters whenever layer name has changed, this should be done for navis too!
  }

  const tryToUpgradeSelectSendFilters = async () => {
    for (const model of documentModelStore.value.models) {
      const isSender = model.typeDiscriminator.toLowerCase().includes('sender')
      if (!isSender) continue //  we do not care about receivers

      if ((model as ISenderModelCard).sendFilter?.type !== 'Select') continue // we do not care about filters other than Select type

      const existingSelectFilter = (model as ISenderModelCard)
        .sendFilter as SendFilterSelect
      const newSelectFilter = availableSelectSendFilters.value[existingSelectFilter.id]
      if (!newSelectFilter) {
        continue
      }
      // here we do the upgrade by checking available select filter items and existing select filter items against ids
      const updatedSelectedItems = existingSelectFilter.selectedItems.map(
        (selected) => {
          const upgraded = newSelectFilter.items.find((item) => item.id === selected.id)
          return upgraded ?? selected
        }
      )

      existingSelectFilter.items = newSelectFilter.items
      existingSelectFilter.selectedItems = updatedSelectedItems
      existingSelectFilter.summary = existingSelectFilter.isMultiSelectable
        ? existingSelectFilter.selectedItems.map((v) => v.name).join(', ')
        : existingSelectFilter.selectedItems[0].name

      // update the state in host app
      await patchModel(model.modelCardId, {
        sendFilters: existingSelectFilter
      })
    }
  }

  const getSendSettings = async () => {
    sendSettings.value = await app.$sendBinding.getSendSettings()
  }

  const getReceiveSettings = async () => {
    receiveSettings.value = await app.$receiveBinding.getReceiveSettings()
  }

  const tryToUpgradeModelCardSettings = (
    settings: CardSetting[],
    typeDiscriminator: string
  ) => {
    if (documentModelStore.value.models.length === 0) return
    const modelCards = documentModelStore.value.models.filter((m) =>
      m.typeDiscriminator.includes(typeDiscriminator)
    )
    if (modelCards.length === 0) return

    const settingIds = settings?.map((s) => s.id) || []
    modelCards.forEach(async (modelCard) => {
      const idsToUpgrade = [] as string[]
      const idsToDrop = [] as string[]

      settingIds?.forEach((id) => {
        const existingSetting = modelCard.settings?.find((s) => s.id === id)

        if (!existingSetting) {
          // If the setting does not exist, it's a new one to upgrade
          idsToUpgrade.push(id)
        } else if (existingSetting.type === 'string' && existingSetting.enum) {
          // Check if existing setting's enum needs upgrading
          const currentEnum = sendSettings.value?.find((s) => s.id === id)?.enum
          if (currentEnum && existingSetting.enum.length !== currentEnum.length) {
            idsToUpgrade.push(id)
          }
        }
      })

      // Identify settings to drop (if they no longer exist in sendSettingIds)
      modelCard.settings?.forEach((setting) => {
        if (!settingIds.includes(setting.id)) {
          idsToDrop.push(setting.id)
        }
      })

      if (idsToUpgrade.length !== 0 || idsToDrop.length !== 0) {
        // Prepare new settings by filtering the old ones and adding upgraded ones
        const newSettings = modelCard.settings?.filter(
          (setting) => !idsToDrop.includes(setting.id)
        )

        idsToUpgrade.forEach((id) => {
          const upgradedSetting = sendSettings.value?.find((s) => s.id === id)
          if (upgradedSetting) {
            newSettings?.push(upgradedSetting)
          }
        })

        // Patch the model with the new settings
        await patchModel(modelCard.modelCardId, {
          settings: newSettings
        })
      }
    })
  }

  app.$baseBinding?.on(
    'documentChanged',
    () =>
      setTimeout(async () => {
        // void trackEvent('DUI3 Action', { name: 'Document changed' }) // noisy
        void refreshDocumentInfo()
        await refreshDocumentModelStore() // need to awaited since upgrading the card settings need documentModelStore in place
        void refreshSendFilters()
        void tryToUpgradeModelCardSettings(sendSettings.value || [], 'SenderModelCard')
      }, 500) // timeout exists because of rhino
  )

  const initializeApp = async () => {
    await getHostAppName()
    await getHostAppVersion()
    await getConnectorVersion()
    await refreshDocumentInfo()
    await refreshDocumentModelStore()
    await refreshSendFilters()
    await getSendSettings()
    await getReceiveSettings()
    tryToUpgradeModelCardSettings(sendSettings.value || [], 'SenderModelCard')

    // Intercom shenanningans below
    // Do not poke intercom in ancient revit version
    if (
      hostAppName.value?.toLowerCase() === 'revit' &&
      hostAppVersion.value?.includes('2022')
    )
      return

    // guards against intercom being sometimes slower to init
    setTimeout(() => {
      app.$intercom.updateConnectorDetails(
        hostAppName.value as string,
        hostAppVersion.value as string,
        connectorVersion.value as string
      )
    }, 1000)
  }

  initializeApp()

  return {
    hostAppName,
    hostAppVersion,
    connectorVersion,
    isConnectorUpToDate,
    latestAvailableVersion,
    documentInfo,
    projectModelGroups,
    models,
    sendFilters,
    sendSettings,
    receiveSettings,
    selectionFilter,
    everythingFilter,
    currentNotification,
    showErrorDialog,
    hostAppError,
    availableViews,
    navisworksAvailableSavedSets,
    availableSelectSendFilters,
    isDistributedBySpeckle,
    setIsDistributedBySpeckle,
    setNotification,
    setModelError,
    setLatestAvailableVersion,
    downloadLatestVersion,
    dismissNotification,
    setHostAppError,
    addModel,
    patchModel,
    removeModel,
    removeAccountModels,
    removeProjectModels,
    sendModel,
    receiveModel,
    sendModelCancel,
    receiveModelCancel,
    refreshSendFilters,
    getSendSettings,
    setModelSendResult,
    setModelReceiveResult,
    handleModelProgressEvents
  }
})
