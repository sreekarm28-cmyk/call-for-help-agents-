import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { placeArea, type AddressComponent } from "../providers/place-display.js";
import { fetchGoogle, TemporaryGoogleError } from "../providers/google-request.js";

type GooglePlace = {
  id: string;
  displayName?: { text: string };
  formattedAddress?: string;
  addressComponents?: AddressComponent[];
  internationalPhoneNumber?: string;
  nationalPhoneNumber?: string;
  rating?: number;
  userRatingCount?: number;
  primaryType?: string;
  types?: string[];
  businessStatus?: string;
  location?: { latitude: number; longitude: number };
};

const fields = [
  "id", "displayName", "formattedAddress", "addressComponents", "internationalPhoneNumber",
  "nationalPhoneNumber", "rating", "userRatingCount", "location", "primaryType", "types", "businessStatus",
].map((field) => `places.${field}`).join(",");
const nearbyTypes = new Set(["electrician", "plumber", "locksmith", "painter", "roofing_contractor"]);

serveStdio(() => {
  const server = new McpServer(
    { name: "google-places", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.registerTool("find_nearby_providers", {
    description: "Find local service providers within a radius of a geographic point.",
    inputSchema: z.union([z.object({
      serviceType: z.string().trim().min(1).max(100),
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
      radiusMeters: z.number().positive().max(50_000),
      maxResults: z.number().int().min(1).max(20),
    }), z.object({
      serviceType: z.string().trim().min(1).max(100),
      serviceAddress: z.string().trim().min(1).max(500),
      maxResults: z.number().int().min(1).max(20),
    })]),
  }, async (input) => {
    const apiKey = process.env.GOOGLE_MAPS_API_KEY?.trim();
    if (!apiKey || apiKey === "replace_with_your_google_places_api_key") {
      throw new Error("Set GOOGLE_MAPS_API_KEY in the backend environment.");
    }

    const search = "serviceAddress" in input
      ? {
          method: "searchText",
          body: {
            textQuery: `${input.serviceType} near ${input.serviceAddress}`,
            pageSize: input.maxResults,
            regionCode: "IN",
          },
        }
      : nearbyTypes.has(input.serviceType) ? {
          method: "searchNearby",
          body: {
            includedTypes: [input.serviceType],
            maxResultCount: input.maxResults,
            locationRestriction: {
              circle: {
                center: { latitude: input.latitude, longitude: input.longitude },
                radius: input.radiusMeters,
              },
            },
          },
        } : {
          method: "searchText",
          body: {
            textQuery: input.serviceType,
            pageSize: input.maxResults,
            locationBias: {
              circle: {
                center: { latitude: input.latitude, longitude: input.longitude },
                radius: input.radiusMeters,
              },
            },
          },
        };

    let response: Response;
    try {
      response = await fetchGoogle(`Google Places ${search.method}`, `https://places.googleapis.com/v1/places:${search.method}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": apiKey,
          "X-Goog-FieldMask": fields,
        },
        body: JSON.stringify(search.body),
      });
    } catch (error) {
      if (!(error instanceof TemporaryGoogleError)) throw error;
      return {
        isError: true,
        content: [{ type: "text", text: error.message }],
        structuredContent: { retryable: true },
      };
    }

    const data = await response.json() as { places?: GooglePlace[] };
    const providers = (data.places ?? []).map((place) => ({
      placeId: place.id,
      name: place.displayName?.text ?? null,
      address: place.formattedAddress ?? null,
      area: placeArea(place.addressComponents),
      phoneNumber: place.internationalPhoneNumber ?? place.nationalPhoneNumber ?? null,
      rating: place.rating ?? null,
      ratingCount: place.userRatingCount ?? null,
      primaryType: place.primaryType ?? null,
      types: place.types ?? [],
      businessStatus: place.businessStatus ?? null,
      location: place.location ?? null,
    }));

    return {
      content: [{ type: "text", text: JSON.stringify({ providers }) }],
      structuredContent: { providers },
    };
  });

  return server;
});
