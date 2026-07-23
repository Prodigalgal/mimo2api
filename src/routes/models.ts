import type { FastifyPluginAsync } from "fastify";
import type { ConfigStore } from "../config/store.js";
import { ApiError } from "../core/errors.js";
import { requireApiKey } from "../core/auth.js";
import type { ModelService } from "../models/service.js";

export const modelRoutes = (config: ConfigStore, models: ModelService): FastifyPluginAsync => async (app) => {
  app.addHook("preHandler", requireApiKey(config));

  app.get("/v1/models", async () => ({
    object: "list",
    data: models.list().map(modelObject),
  }));

  app.post("/v1/models/refresh", async () => ({
    object: "list",
    data: (await models.refresh()).map(modelObject),
  }));

  app.get<{ Params: { modelId: string } }>("/v1/models/:modelId", async (request) => {
    const model = models.list().find((item) => item === request.params.modelId);
    if (!model) throw new ApiError(404, "model_not_found", `model ${request.params.modelId} not found`);
    return modelObject(model);
  });
};

const modelObject = (id: string) => ({
  id,
  object: "model",
  created: 1_681_940_951,
  owned_by: "xiaomi",
  context_length: id.includes("2.5-pro") ? 1_048_576 : 262_144,
  max_output_tokens: id.includes("2.5-pro") ? 131_072 : 65_536,
});
