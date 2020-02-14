/*
 * Copyright (C) 2018-2020 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import deline = require("deline")

import { Module, FileCopySpec } from "../../types/module"
import {
  joiUserIdentifier,
  joiArray,
  PrimitiveMap,
  joiPrimitive,
  joi,
  envVarRegex,
  Primitive,
  joiModuleIncludeDirective,
} from "../../config/common"
import { ArtifactSpec } from "./../../config/validation"
import { Service, ingressHostnameSchema, linkUrlSchema } from "../../types/service"
import { DEFAULT_PORT_PROTOCOL } from "../../constants"
import { ModuleSpec, ModuleConfig, baseBuildSpecSchema, BaseBuildSpec } from "../../config/module"
import { CommonServiceSpec, ServiceConfig, baseServiceSpecSchema } from "../../config/service"
import { baseTaskSpecSchema, BaseTaskSpec } from "../../config/task"
import { baseTestSpecSchema, BaseTestSpec } from "../../config/test"
import { joiStringMap } from "../../config/common"
import { dedent } from "../../util/string"

export const defaultContainerLimits: ServiceLimitSpec = {
  cpu: 1000, // = 1000 millicpu = 1 CPU
  memory: 1024, // = 1024MB = 1GB
}

export interface ContainerIngressSpec {
  annotations: Annotations
  linkUrl?: string
  hostname?: string
  path: string
  port: string
}

export type ServicePortProtocol = "TCP" | "UDP"

export interface ServicePortSpec {
  name: string
  protocol: ServicePortProtocol
  containerPort: number
  // Defaults to containerPort
  servicePort: number
  hostPort?: number
  nodePort?: number | true
}

export interface ServiceVolumeSpec {
  name: string
  containerPath: string
  hostPath?: string
}

export interface ServiceHealthCheckSpec {
  httpGet?: {
    path: string
    port: string
    scheme?: "HTTP" | "HTTPS"
  }
  command?: string[]
  tcpPort?: string
}

export interface ServiceLimitSpec {
  cpu: number
  memory: number
}

interface Annotations {
  [name: string]: string
}

export interface ContainerServiceSpec extends CommonServiceSpec {
  annotations: Annotations
  command?: string[]
  args: string[]
  daemon: boolean
  ingresses: ContainerIngressSpec[]
  env: PrimitiveMap
  healthCheck?: ServiceHealthCheckSpec
  hotReloadCommand?: string[]
  hotReloadArgs?: string[]
  limits: ServiceLimitSpec
  ports: ServicePortSpec[]
  replicas?: number
  volumes: ServiceVolumeSpec[]
}

export const commandExample = ["/bin/sh", "-c"]

const hotReloadSyncSchema = joi.object().keys({
  source: joi
    .posixPath()
    .relativeOnly()
    .subPathOnly()
    .allowGlobs()
    .default(".")
    .description(
      deline`
        POSIX-style path of the directory to sync to the target, relative to the module's top-level directory.
        Must be a relative path if provided. Defaults to the module's top-level directory if no value is provided.`
    )
    .example("src"),
  target: joi
    .posixPath()
    .absoluteOnly()
    .required()
    .description(
      deline`
        POSIX-style absolute path to sync the directory to inside the container. The root path (i.e. "/") is
        not allowed.`
    )
    .example("/app/src"),
})

export interface ContainerHotReloadSpec {
  sync: FileCopySpec[]
  postSyncCommand?: string[]
}

const hotReloadConfigSchema = joi.object().keys({
  sync: joi
    .array()
    .items(hotReloadSyncSchema)
    .required()
    .description("Specify one or more source files or directories to automatically sync into the running container."),
  postSyncCommand: joi
    .array()
    .items(joi.string())
    .optional()
    .description(`An optional command to run inside the container after syncing.`)
    .example(["rebuild-static-assets.sh"]),
}).description(deline`
    Specifies which files or directories to sync to which paths inside the running containers of hot reload-enabled
    services when those files or directories are modified. Applies to this module's services, and to services
    with this module as their \`sourceModule\`.
  `)

export type ContainerServiceConfig = ServiceConfig<ContainerServiceSpec>

const annotationsSchema = joiStringMap(joi.string())
  .example({ "nginx.ingress.kubernetes.io/proxy-body-size": "0" })
  .default(() => ({}))

export interface EnvSecretRef {
  secretRef: {
    name: string
    key?: string
  }
}

const secretRefSchema = joi
  .object()
  .keys({
    secretRef: joi.object().keys({
      name: joi
        .string()
        .required()
        .description("The name of the secret to refer to."),
      key: joi
        .string()
        .description("The key to read from in the referenced secret. May be required for some providers."),
    }),
  })
  .description(
    "A reference to a secret, that should be applied to the environment variable. " +
      "Note that this secret must already be defined in the provider."
  )

export interface ContainerEnvVars {
  [key: string]: Primitive | EnvSecretRef
}

export const containerEnvVarsSchema = joi
  .object()
  .pattern(envVarRegex, joi.alternatives(joiPrimitive(), secretRefSchema))
  .default(() => ({}))
  .unknown(false)
  .description(
    "Key/value map of environment variables. Keys must be valid POSIX environment variable names " +
      "(must not start with `GARDEN`) and values must be primitives or references to secrets."
  )
  .example([
    {
      MY_VAR: "some-value",
      MY_SECRET_VAR: { secretRef: { name: "my-secret", key: "some-key" } },
    },
    {},
  ])

const ingressSchema = joi.object().keys({
  annotations: annotationsSchema.description(
    "Annotations to attach to the ingress (Note: May not be applicable to all providers)"
  ),
  hostname: ingressHostnameSchema,
  linkUrl: linkUrlSchema,
  path: joi
    .string()
    .default("/")
    .description("The path which should be routed to the service."),
  port: joi
    .string()
    .required()
    .description("The name of the container port where the specified paths should be routed."),
})

const healthCheckSchema = joi
  .object()
  .keys({
    httpGet: joi
      .object()
      .keys({
        path: joi
          .string()
          .uri(<any>{ relativeOnly: true })
          .required()
          .description("The path of the service's health check endpoint."),
        port: joi
          .string()
          .required()
          .description("The name of the port where the service's health check endpoint should be available."),
        scheme: joi
          .string()
          .allow("HTTP", "HTTPS")
          .default("HTTP"),
      })
      .description("Set this to check the service's health by making an HTTP request."),
    command: joi
      .array()
      .items(joi.string())
      .description("Set this to check the service's health by running a command in its container."),
    tcpPort: joi
      .string()
      .description("Set this to check the service's health by checking if this TCP port is accepting connections."),
  })
  .xor("httpGet", "command", "tcpPort")

const limitsSchema = joi.object().keys({
  cpu: joi
    .number()
    .default(defaultContainerLimits.cpu)
    .min(10)
    .description("The maximum amount of CPU the service can use, in millicpus (i.e. 1000 = 1 CPU)"),
  memory: joi
    .number()
    .default(defaultContainerLimits.memory)
    .min(64)
    .description("The maximum amount of RAM the service can use, in megabytes (i.e. 1024 = 1 GB)"),
})

export const portSchema = joi.object().keys({
  name: joiUserIdentifier()
    .required()
    .description("The name of the port (used when referencing the port elsewhere in the service configuration)."),
  protocol: joi
    .string()
    .allow("TCP", "UDP")
    .default(DEFAULT_PORT_PROTOCOL)
    .description("The protocol of the port."),
  containerPort: joi
    .number()
    .required()
    .example(8080).description(deline`
        The port exposed on the container by the running process. This will also be the default value
        for \`servicePort\`.

        This is the port you would expose in your Dockerfile and that your process listens on.
        This is commonly a non-priviledged port like 8080 for security reasons.

        The service port maps to the container port:

        \`servicePort:80 -> containerPort:8080 -> process:8080\``),
  servicePort: joi
    .number()
    .default((context) => context.containerPort)
    .example(80).description(deline`
        The port exposed on the service.
        Defaults to \`containerPort\` if not specified.

        This is the port you use when calling a service from another service within the cluster.
        For example, if your service name is my-service and the service port is 8090,
        you would call it with: http://my-service:8090/some-endpoint.

        It is common to use port 80, the default port number, so that you can call the service
        directly with http://my-service/some-endpoint.

        The service port maps to the container port:

        \`servicePort:80 -> containerPort:8080 -> process:8080\``),
  hostPort: joi.number().meta({ deprecated: true }),
  nodePort: joi.number().allow(true).description(deline`
        Set this to expose the service on the specified port on the host node (may not be supported by all providers).
        Set to \`true\` to have the cluster pick a port automatically, which is most often advisable if the cluster is
        shared by multiple users.

        This allows you to call the service from the outside by the node's IP address
        and the port number set in this field.
      `),
})

const volumeSchema = joi.object().keys({
  name: joiUserIdentifier()
    .required()
    .description("The name of the allocated volume."),
  containerPath: joi
    .posixPath()
    .required()
    .description("The path where the volume should be mounted in the container."),
  hostPath: joi
    .posixPath()
    .description(
      dedent`
        _NOTE: Usage of hostPath is generally discouraged, since it doesn't work reliably across different platforms
        and providers. Some providers may not support it at all._

        A local path or path on the node that's running the container, to mount in the container, relative to the
        module source path (or absolute).
      `
    )
    .example("/some/dir"),
})

const serviceSchema = baseServiceSpecSchema.keys({
  annotations: annotationsSchema.description(
    "Annotations to attach to the service (Note: May not be applicable to all providers)."
  ),
  command: joi
    .array()
    .items(joi.string())
    .description("The command/entrypoint to run the container with when starting the service.")
    .example(commandExample),
  args: joi
    .array()
    .items(joi.string())
    .description("The arguments to run the container with when starting the service.")
    .example(["npm", "start"]),
  daemon: joi.boolean().default(false).description(deline`
        Whether to run the service as a daemon (to ensure exactly one instance runs per node).
        May not be supported by all providers.
      `),
  ingresses: joiArray(ingressSchema)
    .description("List of ingress endpoints that the service exposes.")
    .example([{ path: "/api", port: "http" }]),
  env: containerEnvVarsSchema,
  healthCheck: healthCheckSchema.description("Specify how the service's health should be checked after deploying."),
  hotReloadCommand: joi
    .array()
    .items(joi.string())
    .description(
      deline`
        If this module uses the \`hotReload\` field, the container will be run with
        this command/entrypoint when the service is deployed with hot reloading enabled.`
    )
    .example(commandExample),
  hotReloadArgs: joi
    .array()
    .items(joi.string())
    .description(
      deline`
        If this module uses the \`hotReload\` field, the container will be run with
        these arguments when the service is deployed with hot reloading enabled.`
    )
    .example(["npm", "run", "dev"]),
  limits: limitsSchema.description("Specify resource limits for the service.").default(defaultContainerLimits),
  ports: joiArray(portSchema)
    .unique("name")
    .description("List of ports that the service container exposes."),
  replicas: joi.number().integer().description(deline`
      The number of instances of the service to deploy.
      Defaults to 3 for environments configured with \`production: true\`, otherwise 1.

      Note: This setting may be overridden or ignored in some cases. For example, when running with \`daemon: true\`,
      with hot-reloading enabled, or if the provider doesn't support multiple replicas.
    `),
  volumes: joiArray(volumeSchema)
    .unique("name")
    .description("List of volumes that should be mounted when deploying the container."),
})

export interface ContainerRegistryConfig {
  hostname: string
  port?: number
  namespace: string
}

export const containerRegistryConfigSchema = joi.object().keys({
  hostname: joi
    .string()
    .required()
    .description("The hostname (and optionally port, if not the default port) of the registry.")
    .example("gcr.io"),
  port: joi
    .number()
    .integer()
    .description("The port where the registry listens on, if not the default."),
  namespace: joi
    .string()
    .default("_")
    .description("The namespace in the registry where images should be pushed.")
    .example("my-project"),
}).description(dedent`
    The registry where built containers should be pushed to, and then pulled to the cluster when deploying services.

    Important: If you specify this in combination with \`buildMode: cluster-docker\` or \`buildMode: kaniko\`, you must make sure \`imagePullSecrets\` includes authentication with the specified deployment registry, that has the appropriate write privileges (usually full write access to the configured \`deploymentRegistry.namespace\`).
  `)

export interface ContainerService extends Service<ContainerModule> {}

export const containerArtifactSchema = joi.object().keys({
  source: joi
    .posixPath()
    .allowGlobs()
    .absoluteOnly()
    .required()
    .description("A POSIX-style path or glob to copy. Must be an absolute path. May contain wildcards.")
    .example("/output/**/*"),
  target: joi
    .posixPath()
    .relativeOnly()
    .subPathOnly()
    .default(".")
    .description("A POSIX-style path to copy the artifacts to, relative to the project artifacts directory.")
    .example("outputs/foo/"),
})

const artifactsSchema = joi
  .array()
  .items(containerArtifactSchema)
  .description(
    deline`
      Specify artifacts to copy out of the container after the run.

      Note: Depending on the provider, this may require the container image to include \`sh\` \`tar\`, in order
      to enable the file transfer.
    `
  )
  .example([{ source: "/report/**/*" }])

export interface ContainerTestSpec extends BaseTestSpec {
  args: string[]
  artifacts: ArtifactSpec[]
  command?: string[]
  env: ContainerEnvVars
}

export const containerTestSchema = baseTestSpecSchema.keys({
  args: joi
    .array()
    .items(joi.string())
    .description("The arguments used to run the test inside the container.")
    .example(["npm", "test"]),
  artifacts: artifactsSchema,
  command: joi
    .array()
    .items(joi.string())
    .description("The command/entrypoint used to run the test inside the container.")
    .example(commandExample),
  env: containerEnvVarsSchema,
})

export interface ContainerTaskSpec extends BaseTaskSpec {
  args: string[]
  artifacts: ArtifactSpec[]
  command?: string[]
  env: ContainerEnvVars
}

export const containerTaskSchema = baseTaskSpecSchema
  .keys({
    args: joi
      .array()
      .items(joi.string())
      .description("The arguments used to run the task inside the container.")
      .example(["rake", "db:migrate"]),
    artifacts: artifactsSchema,
    command: joi
      .array()
      .items(joi.string())
      .description("The command/entrypoint used to run the task inside the container.")
      .example(commandExample),
    env: containerEnvVarsSchema,
  })
  .description("A task that can be run in the container.")

export interface ContainerBuildSpec extends BaseBuildSpec {
  targetImage?: string
  timeout: number
}

export interface ContainerModuleSpec extends ModuleSpec {
  build: ContainerBuildSpec
  buildArgs: PrimitiveMap
  extraFlags: string[]
  image?: string
  dockerfile?: string
  hotReload?: ContainerHotReloadSpec
  services: ContainerServiceSpec[]
  tests: ContainerTestSpec[]
  tasks: ContainerTaskSpec[]
}

export interface ContainerModuleConfig extends ModuleConfig<ContainerModuleSpec> {}

export const defaultNamespace = "_"
export const defaultTag = "latest"

export const containerModuleSpecSchema = joi
  .object()
  .keys({
    build: baseBuildSpecSchema.keys({
      targetImage: joi.string().description(deline`
            For multi-stage Dockerfiles, specify which image to build (see
            https://docs.docker.com/engine/reference/commandline/build/#specifying-target-build-stage---target for
            details).
          `),
      timeout: joi
        .number()
        .integer()
        .default(1200)
        .description("Maximum time in seconds to wait for build to finish."),
    }),
    buildArgs: joi
      .object()
      .pattern(/.+/, joiPrimitive())
      .default(() => ({}))
      .description("Specify build arguments to use when building the container image."),
    extraFlags: joi.array().items(joi.string()).description(deline`
        Specify extra flags to use when building the container image.
        Note that arguments may not be portable across implementations.`),
    // TODO: validate the image name format
    image: joi.string().description(deline`
        Specify the image name for the container. Should be a valid Docker image identifier. If specified and
        the module does not contain a Dockerfile, this image will be used to deploy services for this module.
        If specified and the module does contain a Dockerfile, this identifier is used when pushing the built image.`),
    include: joiModuleIncludeDirective(dedent`
      If neither \`include\` nor \`exclude\` is set, and the module has a Dockerfile, Garden
      will parse the Dockerfile and automatically set \`include\` to match the files and
      folders added to the Docker image (via the \`COPY\` and \`ADD\` directives in the Dockerfile).

      If neither \`include\` nor \`exclude\` is set, and the module
      specifies a remote image, Garden automatically sets \`include\` to \`[]\`.
    `),
    hotReload: hotReloadConfigSchema,
    dockerfile: joi
      .posixPath()
      .subPathOnly()
      .description("POSIX-style name of Dockerfile, relative to module root."),
    services: joiArray(serviceSchema)
      .unique("name")
      .description("A list of services to deploy from this container module."),
    tests: joiArray(containerTestSchema).description("A list of tests to run in the module."),
    // We use the user-facing term "tasks" as the key here, instead of "tasks".
    tasks: joiArray(containerTaskSchema).description(deline`
        A list of tasks that can be run from this container module. These can be used as dependencies for services
        (executed before the service is deployed) or for other tasks.
      `),
  })
  .description("Configuration for a container module.")

export interface ContainerModule<
  M extends ContainerModuleSpec = ContainerModuleSpec,
  S extends ContainerServiceSpec = ContainerServiceSpec,
  T extends ContainerTestSpec = ContainerTestSpec,
  W extends ContainerTaskSpec = ContainerTaskSpec
> extends Module<M, S, T, W> {}
