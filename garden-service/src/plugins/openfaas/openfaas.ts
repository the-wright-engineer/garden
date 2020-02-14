/*
 * Copyright (C) 2018-2020 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { join } from "path"
import { ConfigurationError } from "../../exceptions"
import { ServiceStatus, ServiceIngress, ServiceProtocol } from "../../types/service"
import { testExecModule } from "../exec"
import { getNamespace } from "../kubernetes/namespace"
import { findByName, sleep } from "../../util/util"
import { KubeApi } from "../kubernetes/api"
import { waitForResources } from "../kubernetes/status/status"
import { checkWorkloadStatus } from "../kubernetes/status/workload"
import { createGardenPlugin } from "../../types/plugin/plugin"
import { faasCli } from "./faas-cli"
import { getAllLogs } from "../kubernetes/logs"
import { DeployServiceParams } from "../../types/plugin/service/deployService"
import { GetServiceStatusParams } from "../../types/plugin/service/getServiceStatus"
import { GetServiceLogsParams } from "../../types/plugin/service/getServiceLogs"
import { DeleteServiceParams } from "../../types/plugin/service/deleteService"
import { HelmModuleConfig } from "../kubernetes/helm/config"
import { DEFAULT_API_VERSION, STATIC_DIR, DOCS_BASE_URL } from "../../constants"
import { ExecModuleConfig } from "../exec"
import { ConfigureProviderParams, ConfigureProviderResult } from "../../types/plugin/provider/configureProvider"
import { KubernetesDeployment } from "../kubernetes/types"
import {
  configSchema,
  getK8sProvider,
  OpenFaasConfig,
  OpenFaasModule,
  OpenFaasProvider,
  OpenFaasPluginContext,
  OpenFaasService,
  getServicePath,
  configureModule,
  openfaasModuleOutputsSchema,
  openfaasModuleSpecSchema,
  getExternalGatewayUrl,
} from "./config"
import { getOpenfaasModuleBuildStatus, buildOpenfaasModule, writeStackFile, stackFilename } from "./build"
import { dedent } from "../../util/string"
import { LogEntry } from "../../logger/log-entry"
import { Provider } from "../../config/provider"
import { parse } from "url"
import { trim } from "lodash"

const systemDir = join(STATIC_DIR, "openfaas", "system")

export const gardenPlugin = createGardenPlugin({
  name: "openfaas",
  configSchema,
  dependencies: ["kubernetes"],
  docs: dedent`
    This provider adds support for [OpenFaaS](https://www.openfaas.com/). It adds the [\`openfaas\` module type](${DOCS_BASE_URL}/module-types/openfaas) and (by default) installs the \`faas-netes\` runtime to the project namespace. Each \`openfaas\` module maps to a single OpenFaaS function.

    See the reference below for configuration options for \`faas-netes\`, and the [module type docs](${DOCS_BASE_URL}/module-types/openfaas) for how to configure the individual functions.

    Also see the [openfaas example project](https://github.com/garden-io/garden/tree/master/examples/openfaas) for a simple usage example.
  `,
  handlers: {
    configureProvider,
  },
  createModuleTypes: [
    {
      name: "openfaas",
      docs: dedent`
      Deploy a [OpenFaaS](https://www.openfaas.com/) function using Garden. Requires the \`openfaas\` provider
      to be configured.
    `,
      moduleOutputsSchema: openfaasModuleOutputsSchema,
      schema: openfaasModuleSpecSchema,
      handlers: {
        configure: configureModule,
        getBuildStatus: getOpenfaasModuleBuildStatus,
        build: buildOpenfaasModule,
        // TODO: design and implement a proper test flow for openfaas functions
        testModule: testExecModule,
        getServiceStatus,
        getServiceLogs,
        deployService,
        deleteService,
      },
    },
  ],
})

const templateModuleConfig: ExecModuleConfig = {
  allowPublish: false,
  apiVersion: DEFAULT_API_VERSION,
  build: {
    dependencies: [],
  },
  description: "OpenFaaS templates for building functions",
  disabled: false,
  name: "templates",
  path: join(systemDir, "openfaas-templates"),
  repositoryUrl: "https://github.com/openfaas/templates.git#1.2",
  outputs: {},
  serviceConfigs: [],
  spec: {
    build: {
      command: [],
      dependencies: [],
    },
    env: {},
    tasks: [],
    tests: [],
  },
  taskConfigs: [],
  testConfigs: [],
  type: "exec",
}

async function configureProvider({
  log,
  config,
  projectName,
  dependencies,
}: ConfigureProviderParams<OpenFaasConfig>): Promise<ConfigureProviderResult> {
  const k8sProvider = getK8sProvider(dependencies)

  if (!config.faasNetes?.install || config.faasNetes?.values) {
    // The user is manually configuring faas-netes
    if (!config.gatewayUrl) {
      throw new ConfigurationError(
        `openfaas: gatewayUrl field must be configured when manually configuring or installing faas-netes.`,
        { config }
      )
    }
  } else {
    // We set a basic default configuration
    if (!config.hostname) {
      if (!k8sProvider.config.defaultHostname) {
        throw new ConfigurationError(
          `openfaas: hostname field must be configured if no default hostname is configured on Kubernetes provider.`,
          { config }
        )
      }

      config.hostname = k8sProvider.config.defaultHostname
    }
  }

  const namespace = await getFunctionNamespace(log, projectName, config, dependencies)
  // Need to scope the release name, because the OpenFaaS Helm chart installs some cluster-wide resources
  // that could conflict across projects/users.
  const releaseName = `${namespace}--openfaas`

  const defaultValues = {
    basic_auth: false,
    exposeServices: false,
    functionNamespace: namespace,
    ingress: {
      enabled: true,
      hosts: [
        {
          host: config.hostname,
          serviceName: "gateway",
          servicePort: 8080,
          path: "/function/",
        },
        {
          host: config.hostname,
          serviceName: "gateway",
          servicePort: 8080,
          path: "/system/",
        },
      ],
    },
    faasIdler: {
      create: false,
    },
    faasnetes: {
      imagePullPolicy: "IfNotPresent",
    },
    securityContext: false,
  }

  const systemModule: HelmModuleConfig = {
    allowPublish: false,
    apiVersion: DEFAULT_API_VERSION,
    build: {
      dependencies: [],
    },
    description: "OpenFaaS runtime",
    disabled: false,
    name: "system",
    outputs: {},
    path: join(systemDir, "openfaas-system"),
    serviceConfigs: [],
    taskConfigs: [],
    testConfigs: [],
    type: "helm",
    spec: {
      repo: "https://openfaas.github.io/faas-netes/",
      chart: "openfaas",
      chartPath: ".",
      dependencies: [],
      skipDeploy: false,
      tasks: [],
      tests: [],
      timeout: 900,
      version: "5.2.1",
      releaseName,
      values: config.faasNetes.values || defaultValues,
      valueFiles: [],
    },
  }

  const moduleConfigs = [systemModule, templateModuleConfig]

  return { config, moduleConfigs }
}

async function getFunctionNamespace(
  log: LogEntry,
  projectName: string,
  config: OpenFaasConfig,
  dependencies: Provider[]
) {
  // Check for configured namespace in faas-netes custom values
  return (
    (config.values && config.values.functionNamespace) ||
    // Default to K8s app namespace
    (await getNamespace({
      log,
      provider: getK8sProvider(dependencies),
      projectName,
      skipCreate: true,
    }))
  )
}

async function getServiceLogs(params: GetServiceLogsParams<OpenFaasModule>) {
  const { ctx, log, service } = params
  const namespace = await getFunctionNamespace(
    log,
    ctx.projectName,
    ctx.provider.config as OpenFaasConfig,
    ctx.provider.dependencies
  )

  const k8sProvider = getK8sProvider(ctx.provider.dependencies)
  const api = await KubeApi.factory(log, k8sProvider)
  const resources = await getResources(api, service, namespace)

  return getAllLogs({ ...params, provider: k8sProvider, defaultNamespace: namespace, resources })
}

const faasNetesInitTimeout = 10000
const retryWait = 1000

async function deployService(params: DeployServiceParams<OpenFaasModule>): Promise<ServiceStatus> {
  const { ctx, module, service, log, runtimeContext } = params
  const k8sProvider = getK8sProvider(ctx.provider.dependencies)

  // write the stack file again with environment variables
  const envVars = { ...runtimeContext.envVars, ...module.spec.env }
  await writeStackFile(<OpenFaasProvider>ctx.provider, k8sProvider, module, envVars)

  // use faas-cli to do the deployment
  const start = new Date().getTime()

  while (true) {
    try {
      await faasCli.stdout({
        log,
        cwd: module.buildPath,
        args: ["deploy", "-f", stackFilename],
      })
      break
    } catch (err) {
      const now = new Date().getTime()

      // Retry a few times in case faas-netes is still initializing
      if (err.all?.includes("failed to deploy with status code: 503") && now - start < faasNetesInitTimeout * 1000) {
        await sleep(retryWait)
        continue
      } else {
        throw err
      }
    }
  }

  // wait until deployment is ready
  const namespace = await getFunctionNamespace(
    log,
    ctx.projectName,
    ctx.provider.config as OpenFaasConfig,
    ctx.provider.dependencies
  )
  const api = await KubeApi.factory(log, k8sProvider)
  const resources = await getResources(api, service, namespace)

  await waitForResources({
    namespace,
    provider: k8sProvider,
    serviceName: service.name,
    log,
    resources,
  })

  // TODO: avoid duplicate work here
  return getServiceStatus(params)
}

async function deleteService(params: DeleteServiceParams<OpenFaasModule>): Promise<ServiceStatus> {
  const { ctx, log, service } = params
  let status: ServiceStatus
  let found = true

  try {
    status = await getServiceStatus({
      ctx,
      log,
      service,
      runtimeContext: {
        envVars: {},
        dependencies: [],
      },
      module: service.module,
      hotReload: false,
    })

    found = !!status.state

    await faasCli.stdout({
      log,
      cwd: service.module.buildPath,
      args: ["remove", "-f", stackFilename],
    })
  } catch (err) {
    found = false
    status = { state: "missing", detail: {} }
  }

  if (log) {
    found ? log.setSuccess("Service deleted") : log.setWarn("Service not deployed")
  }

  return status
}

async function getResources(api: KubeApi, service: OpenFaasService, namespace: string) {
  const deployment = await api.apps.readNamespacedDeployment(service.name, namespace)
  return [deployment]
}

async function getServiceStatus({
  ctx,
  module,
  service,
  log,
}: GetServiceStatusParams<OpenFaasModule>): Promise<ServiceStatus> {
  const openFaasCtx = <OpenFaasPluginContext>ctx
  const k8sProvider = getK8sProvider(ctx.provider.dependencies)

  const gatewayUrl = getExternalGatewayUrl(openFaasCtx)
  const parsed = parse(gatewayUrl)
  const protocol = trim(parsed.protocol!, ":") as ServiceProtocol

  const ingresses: ServiceIngress[] = [
    {
      hostname: parsed.hostname!,
      path: getServicePath(module),
      port: protocol === "https" ? 443 : 80,
      protocol,
    },
  ]

  const namespace = await getFunctionNamespace(
    log,
    openFaasCtx.projectName,
    openFaasCtx.provider.config,
    openFaasCtx.provider.dependencies
  )
  const api = await KubeApi.factory(log, k8sProvider)

  let deployment: KubernetesDeployment

  try {
    deployment = await api.apps.readNamespacedDeployment(service.name, namespace)
  } catch (err) {
    if (err.code === 404) {
      return { state: "missing", detail: {} }
    } else {
      throw err
    }
  }

  const container: any = findByName(deployment.spec.template.spec.containers, service.name)
  const envVersion = findByName<any>(container.env, "GARDEN_VERSION")
  const version = envVersion ? envVersion.value : undefined
  const resourceVersion = parseInt(deployment.metadata.resourceVersion!, 10)
  const status = await checkWorkloadStatus({
    api,
    namespace,
    resource: deployment,
    log,
    resourceVersion,
  })

  return {
    state: status.state,
    version,
    ingresses,
    detail: {},
  }
}
