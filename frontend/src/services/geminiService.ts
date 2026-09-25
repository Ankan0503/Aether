import { GoogleGenAI, Type } from "@google/genai";

const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
  console.warn("GEMINI_API_KEY is not defined. AI features will be disabled.");
}

const ai = apiKey ? new GoogleGenAI({ apiKey }) : null;

export interface SmartRule {
  text: string;
  reason: string;
}

export interface EnergyInsight {
  analysis: string;
  recommendations: string[];
}

/**
 * Generates smart automation rule suggestions based on current zones and system state.
 */
export async function getSmartMacroSuggestions(zones: any[]): Promise<SmartRule[]> {
  if (!ai) return [];

  const zonesContext = zones.map(z => ({
    name: z.name,
    type: z.type,
    currentRules: z.rules.map((r: any) => r.text)
  }));

  try {
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: `You are an AI Smart Home Mesh Optimizer. Based on the following home zones and their current automation rules, suggest 3 NEW, highly efficient automation macros.
      
      Zones Context:
      ${JSON.stringify(zonesContext, null, 2)}
      
      Respond with exactly 3 suggestions.`,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              text: {
                type: Type.STRING,
                description: "The automation rule text (e.g., 'Turn off lights if solar gain > 400W')"
              },
              reason: {
                type: Type.STRING,
                description: "Brief reason why this rule is beneficial"
              }
            },
            required: ["text", "reason"]
          }
        }
      }
    });

    const text = response.text;
    if (!text) return [];
    return JSON.parse(text);
  } catch (error) {
    console.error("Error generating smart suggestions:", error);
    return [];
  }
}

/**
 * Analyzes energy consumption and provides insights.
 */
export async function getEnergyInsights(metrics: any, zones: any[]): Promise<EnergyInsight | null> {
  if (!ai) return null;

  const context = {
    totalLoad: metrics.totalLoad,
    efficiency: metrics.efficiency,
    activeNodes: metrics.activeCount,
    zones: zones.map(z => ({
      name: z.name,
      consumption: z.nominalConsumption,
      active: z.active
    }))
  };

  try {
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: `Analyze the current energy consumption of this smart mesh system and provide deep insights and 3 actionable recommendations.
      
      Current State:
      ${JSON.stringify(context, null, 2)}`,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            analysis: {
              type: Type.STRING,
              description: "A professional analysis of the current load and efficiency."
            },
            recommendations: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
              description: "3 actionable optimization steps."
            }
          },
          required: ["analysis", "recommendations"]
        }
      }
    });

    const text = response.text;
    if (!text) return null;
    return JSON.parse(text);
  } catch (error) {
    console.error("Error generating energy insights:", error);
    return null;
  }
}
