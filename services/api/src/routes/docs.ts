import path from "path";
import { NextFunction, Request, Response, Router } from "express";
import swaggerUi from "swagger-ui-express";
import YAML from "yamljs";
import { logger } from "../lib/logger";
import { buildErrorResponse } from "../middleware/requestId";

export const docsRouter: Router = Router();

const OPENAPI_SPEC_PATH = path.resolve(process.cwd(), "docs", "openapi.yaml");

function loadOpenApiSpec() {
  return YAML.load(OPENAPI_SPEC_PATH) as Record<string, unknown>;
}

function renderSwaggerUi(req: Request, res: Response, next: NextFunction) {
  try {
    const handler = swaggerUi.setup(loadOpenApiSpec(), {
      explorer: true,
      customSiteTitle: "Atlas API Docs",
      swaggerOptions: {
        docExpansion: "list",
        persistAuthorization: true,
      },
    });

    return handler(req, res, next);
  } catch (err: any) {
    logger.error({ err: err.message, specPath: OPENAPI_SPEC_PATH }, "Failed to load OpenAPI spec");
    return res.status(500).json(buildErrorResponse(req, "Failed to load API docs"));
  }
}

docsRouter.use(swaggerUi.serve);

docsRouter.get("/openapi.yaml", async (req, res) => {
  res.type("application/yaml");
  res.sendFile(OPENAPI_SPEC_PATH, (err) => {
    if (!err) return;

    logger.error({ err: err.message, specPath: OPENAPI_SPEC_PATH }, "Failed to serve OpenAPI spec");

    if (!res.headersSent) {
      res.status(500).json(buildErrorResponse(req, "Failed to load API docs"));
    }
  });
});

docsRouter.get("/", renderSwaggerUi);
