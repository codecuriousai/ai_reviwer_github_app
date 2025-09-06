// src/services/ai.service.js - Complete Enhanced AI Service with Fix Suggestions and Merge Readiness

const OpenAI = require("openai");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const config = require("../config/config");
const logger = require("../utils/logger");
const { getCodeReviewPrompt } = require("../prompts/prompts");
const {
  buildFixSuggestionPrompt,
  buildMergeReadinessPrompt,
} = require("../prompts/enhanced-prompts");
const {
  retryWithBackoff,
  sanitizeForAI,
  isValidJSON,
  delay,
  generateTrackingId,
} = require("../utils/helpers");

class AIService {
  constructor() {
    this.provider = config.ai.provider;
    this.initializeProviders();
  }

  // Initialize AI providers
  initializeProviders() {
    try {
      if (this.provider === "openai" || config.ai.openai.apiKey) {
        this.openai = new OpenAI({
          apiKey: config.ai.openai.apiKey,
        });
        logger.info("OpenAI client initialized");
      }

      if (this.provider === "gemini" || config.ai.gemini.apiKey) {
        this.gemini = new GoogleGenerativeAI(config.ai.gemini.apiKey);
        this.geminiModel = this.gemini.getGenerativeModel({
          model: config.ai.gemini.model,
        });
        logger.info("Gemini client initialized");
      }
    } catch (error) {
      logger.error("Error initializing AI providers:", error);
      throw new Error("Failed to initialize AI providers");
    }
  }

  // Main function to analyze pull request
  async analyzePullRequest(prData, existingComments = []) {
    try {
      logger.info(`Starting AI analysis for PR #${prData.pr.number}`);

      // Prepare data for analysis
      const analysisData = this.prepareAnalysisData(prData, existingComments);
      const prompt = getCodeReviewPrompt(analysisData, existingComments);

      // Perform analysis with retry logic
      let rawResponse;
      try {
        rawResponse = await retryWithBackoff(async () => {
          if (this.provider === "openai") {
            return await this.analyzeWithOpenAI(prompt);
          } else if (this.provider === "gemini") {
            return await this.analyzeWithGemini(prompt);
          } else {
            throw new Error(`Unsupported AI provider: ${this.provider}`);
          }
        });
      } catch (aiError) {
        logger.error("AI provider error:", aiError);
        return this.createErrorFallbackAnalysis(
          `AI Provider Error: ${aiError.message}`
        );
      }

      // Validate and parse response
      let parsedAnalysis;
      try {
        parsedAnalysis = this.parseAnalysisResponse(rawResponse);
      } catch (parseError) {
        logger.error("Response parsing error:", parseError);
        return this.createErrorFallbackAnalysis(
          `Parsing Error: ${parseError.message}`
        );
      }

      // Enhance analysis with PR context
      const enhancedAnalysis = this.enhanceAnalysisWithContext(
        parsedAnalysis,
        prData,
        existingComments
      );

      logger.info(
        `AI analysis completed. Found ${enhancedAnalysis.automatedAnalysis.totalIssues} issues`
      );
      return enhancedAnalysis;
    } catch (error) {
      logger.error("Critical error in AI analysis:", error);
      return this.createErrorFallbackAnalysis(
        `Critical Error: ${error.message}`
      );
    }
  }

  // NEW: Generate specific code fix suggestions for a finding
  async generateCodeFixSuggestion(finding, fileContent, prData) {
    try {
      logger.info(
        `Generating code fix suggestion for ${finding.file}:${finding.line}`,
        {
          issue: finding.issue,
          severity: finding.severity,
        }
      );

      const prompt = buildFixSuggestionPrompt(finding, fileContent);

      let rawResponse;
      try {
        rawResponse = await retryWithBackoff(async () => {
          if (this.provider === "openai") {
            return await this.analyzeWithOpenAI(prompt);
          } else if (this.provider === "gemini") {
            return await this.analyzeWithGemini(prompt);
          } else {
            throw new Error(`Unsupported AI provider: ${this.provider}`);
          }
        });
      } catch (aiError) {
        logger.error("AI provider error for fix suggestion:", aiError);
        return this.createErrorFixSuggestion(
          finding,
          `AI Provider Error: ${aiError.message}`
        );
      }

      // Parse the fix suggestion response
      let fixSuggestion;
      try {
        fixSuggestion = this.parseFixSuggestionResponse(rawResponse);
      } catch (parseError) {
        logger.error("Fix suggestion parsing error:", parseError);
        return this.createErrorFixSuggestion(
          finding,
          `Parsing Error: ${parseError.message}`
        );
      }

      logger.info(
        `Code fix suggestion generated successfully for ${finding.file}:${finding.line}`
      );
      return fixSuggestion;
    } catch (error) {
      logger.error("Critical error generating fix suggestion:", error);
      return this.createErrorFixSuggestion(
        finding,
        `Critical Error: ${error.message}`
      );
    }
  }

  // NEW: Assess merge readiness based on all available data
  // async assessMergeReadiness(prData, aiFindings, reviewComments, currentStatus) {
  //   try {
  //     logger.info(`Assessing merge readiness for PR #${prData.pr?.number}`, {
  //       aiFindings: aiFindings?.length || 0,
  //       reviewComments: reviewComments?.length || 0
  //     });

  //     const prompt = buildMergeReadinessPrompt(prData, aiFindings, reviewComments, currentStatus);

  //     let rawResponse;
  //     try {
  //       rawResponse = await retryWithBackoff(async () => {
  //         if (this.provider === 'openai') {
  //           return await this.analyzeWithOpenAI(prompt);
  //         } else if (this.provider === 'gemini') {
  //           return await this.analyzeWithGemini(prompt);
  //         } else {
  //           throw new Error(`Unsupported AI provider: ${this.provider}`);
  //         }
  //       });
  //     } catch (aiError) {
  //       logger.error('AI provider error for merge readiness:', aiError);
  //       return this.createErrorMergeAssessment(`AI Provider Error: ${aiError.message}`);
  //     }

  //     // Parse the merge readiness response
  //     let mergeAssessment;
  //     try {
  //       mergeAssessment = this.parseMergeReadinessResponse(rawResponse);
  //     } catch (parseError) {
  //       logger.error('Merge readiness parsing error:', parseError);
  //       return this.createErrorMergeAssessment(`Parsing Error: ${parseError.message}`);
  //     }

  //     logger.info(`Merge readiness assessment completed: ${mergeAssessment.status}`);
  //     return mergeAssessment;

  //   } catch (error) {
  //     logger.error('Critical error assessing merge readiness:', error);
  //     return this.createErrorMergeAssessment(`Critical Error: ${error.message}`);
  //   }
  // }

  async assessMergeReadiness(
    prData,
    aiFindings,
    reviewComments,
    currentStatus
  ) {
    try {
      logger.info(`Assessing merge readiness for PR #${prData.pr?.number}`, {
        aiFindings: aiFindings?.length || 0,
        reviewComments: reviewComments?.length || 0,
      });

      // Analyze AI findings
      const totalAiIssues = aiFindings?.length || 0;
      const criticalIssues =
        aiFindings?.filter(
          (f) => f.severity === "CRITICAL" || f.severity === "BLOCKER"
        ).length || 0;
      const securityIssues =
        aiFindings?.filter(
          (f) =>
            f.category === "VULNERABILITY" || f.category === "SECURITY_HOTSPOT"
        ).length || 0;

      // ENHANCED: Analyze comment resolution status
      const commentAnalysis = this.analyzeCommentResolution(
        reviewComments || []
      );

      logger.info("Comment analysis result:", commentAnalysis);

      // SCENARIO 1: Clean PR with no comments
      if (totalAiIssues === 0 && commentAnalysis.status === "NO_COMMENTS") {
        logger.info(`Clean PR with no comments - ready for merge`);
        return {
          status: "READY_FOR_MERGE",
          reason:
            "No issues detected by automated analysis and no reviewer concerns raised. This appears to be a clean, straightforward change.",
          recommendation:
            "This PR is ready for merge. All automated checks passed with no issues identified.",
          outstanding_issues: [],
          review_quality_assessment: {
            human_review_coverage: "MINIMAL_BUT_ACCEPTABLE",
            ai_analysis_coverage: "COMPLETE",
            critical_issues_addressed: true,
            security_issues_addressed: true,
            total_unresolved_issues: 0,
          },
          merge_readiness_score: 85,
          confidence: "high",
          error: false,
        };
      }

      // SCENARIO 2: Clean PR with resolved/neutral comments
      if (
        totalAiIssues === 0 &&
        (commentAnalysis.status === "RESOLVED_COMMENTS" ||
          commentAnalysis.status === "NEUTRAL_COMMENTS")
      ) {
        logger.info(`Clean PR with resolved comments - ready for merge`);
        return {
          status: "READY_FOR_MERGE",
          reason: `No issues detected by automated analysis and reviewer comments appear to be ${
            commentAnalysis.status === "RESOLVED_COMMENTS"
              ? "resolved"
              : "non-blocking"
          }.`,
          recommendation:
            "This PR is ready for merge. Code quality is good and reviewer feedback has been addressed.",
          outstanding_issues: [],
          review_quality_assessment: {
            human_review_coverage: "ADEQUATE",
            ai_analysis_coverage: "COMPLETE",
            critical_issues_addressed: true,
            security_issues_addressed: true,
            total_unresolved_issues: 0,
          },
          merge_readiness_score: 90,
          confidence: "high",
          error: false,
        };
      }

      // SCENARIO 3: Clean PR but with unresolved blocking comments
      if (
        totalAiIssues === 0 &&
        commentAnalysis.status === "UNRESOLVED_BLOCKING_COMMENTS"
      ) {
        logger.info(
          `Clean code but unresolved reviewer concerns - not ready for merge`
        );
        return {
          status: "NOT_READY_FOR_MERGE",
          reason:
            "While automated analysis found no issues, reviewers have raised concerns that appear unresolved.",
          recommendation:
            "Address the reviewer feedback before proceeding with merge. Focus on resolving change requests.",
          outstanding_issues: commentAnalysis.unresolvedComments.map(
            (comment) => ({
              type: "REVIEW_FEEDBACK",
              severity: "MAJOR",
              description: `Unresolved reviewer comment: ${comment.body.substring(
                0,
                100
              )}...`,
              file: comment.path || "general",
              line: comment.line || 0,
              addressed: false,
            })
          ),
          review_quality_assessment: {
            human_review_coverage: "GOOD",
            ai_analysis_coverage: "COMPLETE",
            critical_issues_addressed: true,
            security_issues_addressed: true,
            total_unresolved_issues: commentAnalysis.unresolvedComments.length,
          },
          merge_readiness_score: 40,
          confidence: "high",
          error: false,
        };
      }

      // SCENARIO 4: Minor issues only with good comment resolution
      if (
        criticalIssues === 0 &&
        securityIssues === 0 &&
        totalAiIssues <= 3 &&
        (commentAnalysis.status === "NO_COMMENTS" ||
          commentAnalysis.status === "RESOLVED_COMMENTS" ||
          commentAnalysis.status === "NEUTRAL_COMMENTS")
      ) {
        const minorIssues =
          aiFindings?.filter(
            (f) => f.severity === "MINOR" || f.severity === "INFO"
          ) || [];

        logger.info(
          `Only minor issues with good comment resolution - ready for merge`
        );
        return {
          status: "READY_FOR_MERGE",
          reason: `Only ${
            minorIssues.length
          } minor/informational issues found with no security vulnerabilities or critical issues. ${
            commentAnalysis.commentCount > 0
              ? "Reviewer feedback appears addressed."
              : "No reviewer concerns raised."
          }`,
          recommendation:
            "This PR is ready for merge. The identified issues are minor and do not block the merge process.",
          outstanding_issues: minorIssues.map((issue) => ({
            type: "MINOR",
            severity: issue.severity,
            description: `${issue.file}:${issue.line} - ${issue.issue}`,
            file: issue.file,
            line: issue.line,
            addressed: false,
          })),
          review_quality_assessment: {
            human_review_coverage:
              commentAnalysis.commentCount > 0
                ? "ADEQUATE"
                : "MINIMAL_BUT_ACCEPTABLE",
            ai_analysis_coverage: "COMPLETE",
            critical_issues_addressed: true,
            security_issues_addressed: true,
            total_unresolved_issues: minorIssues.length,
          },
          merge_readiness_score: commentAnalysis.commentCount > 0 ? 75 : 70,
          confidence: "high",
          error: false,
        };
      }

      // SCENARIO 5: Minor issues but unresolved blocking comments
      if (
        criticalIssues === 0 &&
        securityIssues === 0 &&
        commentAnalysis.status === "UNRESOLVED_BLOCKING_COMMENTS"
      ) {
        logger.info(`Minor issues with unresolved comments - review required`);
        return {
          status: "REVIEW_REQUIRED",
          reason:
            "Code has minor issues and reviewers have raised unresolved concerns that need attention.",
          recommendation:
            "Address both the minor code issues and reviewer feedback before merge.",
          outstanding_issues: [
            ...aiFindings.map((issue) => ({
              type: "CODE_QUALITY",
              severity: issue.severity,
              description: `${issue.file}:${issue.line} - ${issue.issue}`,
              file: issue.file,
              line: issue.line,
              addressed: false,
            })),
            ...commentAnalysis.unresolvedComments.map((comment) => ({
              type: "REVIEW_FEEDBACK",
              severity: "MAJOR",
              description: `Unresolved reviewer comment: ${comment.body.substring(
                0,
                100
              )}...`,
              file: comment.path || "general",
              line: comment.line || 0,
              addressed: false,
            })),
          ],
          review_quality_assessment: {
            human_review_coverage: "GOOD",
            ai_analysis_coverage: "COMPLETE",
            critical_issues_addressed: false,
            security_issues_addressed: true,
            total_unresolved_issues:
              totalAiIssues + commentAnalysis.unresolvedComments.length,
          },
          merge_readiness_score: 45,
          confidence: "medium",
          error: false,
        };
      }

      // For cases with significant issues, proceed with enhanced AI assessment
      const prompt = buildMergeReadinessPrompt(
        prData,
        aiFindings,
        reviewComments,
        currentStatus
      );

      let rawResponse;
      try {
        rawResponse = await retryWithBackoff(async () => {
          if (this.provider === "openai") {
            return await this.analyzeWithOpenAI(prompt);
          } else if (this.provider === "gemini") {
            return await this.analyzeWithGemini(prompt);
          } else {
            throw new Error(`Unsupported AI provider: ${this.provider}`);
          }
        });
      } catch (aiError) {
        logger.error("AI provider error for merge readiness:", aiError);
        return this.createErrorMergeAssessment(
          `AI Provider Error: ${aiError.message}`
        );
      }

      // Parse the merge readiness response
      let mergeAssessment;
      try {
        mergeAssessment = this.parseMergeReadinessResponse(rawResponse);
      } catch (parseError) {
        logger.error("Merge readiness parsing error:", parseError);
        return this.createErrorMergeAssessment(
          `Parsing Error: ${parseError.message}`
        );
      }

      // POST-PROCESSING: Apply comment resolution logic to AI decision
      if (
        commentAnalysis.status === "UNRESOLVED_BLOCKING_COMMENTS" &&
        mergeAssessment.status === "READY_FOR_MERGE"
      ) {
        logger.warn(
          "Overriding AI decision due to unresolved blocking comments"
        );
        mergeAssessment.status = "NOT_READY_FOR_MERGE";
        mergeAssessment.reason =
          "Overridden: Unresolved blocking reviewer comments require attention before merge.";
        mergeAssessment.merge_readiness_score = Math.min(
          mergeAssessment.merge_readiness_score || 50,
          45
        );
      }

      // Override AI being too conservative for truly clean PRs
      if (
        mergeAssessment.status === "NOT_READY_FOR_MERGE" &&
        totalAiIssues === 0 &&
        (commentAnalysis.status === "NO_COMMENTS" ||
          commentAnalysis.status === "RESOLVED_COMMENTS")
      ) {
        logger.warn(
          "AI incorrectly marked clean PR as not ready - overriding to READY_FOR_MERGE"
        );
        mergeAssessment.status = "READY_FOR_MERGE";
        mergeAssessment.reason =
          "Override: No issues found and no unresolved reviewer concerns.";
        mergeAssessment.recommendation =
          "This PR passed all checks with no issues identified.";
        mergeAssessment.merge_readiness_score = Math.max(
          mergeAssessment.merge_readiness_score || 0,
          85
        );
      }

      logger.info(
        `Merge readiness assessment completed: ${mergeAssessment.status}`
      );
      return mergeAssessment;
    } catch (error) {
      logger.error("Critical error assessing merge readiness:", error);
      return this.createErrorMergeAssessment(
        `Critical Error: ${error.message}`
      );
    }
  }

  // NEW: Helper method to analyze comment resolution status
  analyzeCommentResolution(reviewComments) {
    if (!reviewComments || reviewComments.length === 0) {
      return {
        status: "NO_COMMENTS",
        commentCount: 0,
        unresolvedComments: [],
        resolvedCount: 0,
      };
    }

    // Categorize comments
    const requestingChanges = reviewComments.filter((comment) => {
      const body = comment.body.toLowerCase();
      return (
        body.includes("request changes") ||
        body.includes("needs fix") ||
        body.includes("must fix") ||
        body.includes("blocking") ||
        body.includes("please change") ||
        body.includes("should fix") ||
        body.includes("required:") ||
        (body.includes("not") &&
          (body.includes("approve") || body.includes("ready")))
      );
    });

    const approvals = reviewComments.filter((comment) => {
      const body = comment.body.toLowerCase();
      return (
        body.includes("approve") ||
        body.includes("lgtm") ||
        body.includes("looks good") ||
        body.includes("ship it") ||
        body.includes("ready to merge") ||
        body.includes("👍") ||
        body.includes(":+1:")
      );
    });

    const resolutionIndicators = reviewComments.filter((comment) => {
      const body = comment.body.toLowerCase();
      return (
        body.includes("resolved") ||
        body.includes("fixed") ||
        body.includes("addressed") ||
        body.includes("done") ||
        body.includes("completed") ||
        body.includes("thank you") ||
        body.includes("thanks for fixing") ||
        body.includes("updated")
      );
    });

    const questionsOrSuggestions = reviewComments.filter((comment) => {
      const body = comment.body.toLowerCase();
      return (
        body.includes("?") ||
        body.includes("consider") ||
        body.includes("suggest") ||
        body.includes("might want to") ||
        body.includes("could") ||
        body.includes("optional:")
      );
    });

    // Determine status based on analysis
    let status;
    let unresolvedComments = [];

    if (requestingChanges.length > 0) {
      // Check if change requests have been resolved
      const unresolved = requestingChanges.filter((changeRequest) => {
        // Look for resolution indicators after the change request
        const changeRequestTime = new Date(changeRequest.createdAt).getTime();
        const laterResolutions = resolutionIndicators.filter((resolution) => {
          const resolutionTime = new Date(resolution.createdAt).getTime();
          return resolutionTime > changeRequestTime;
        });
        return laterResolutions.length === 0;
      });

      if (unresolved.length > 0) {
        status = "UNRESOLVED_BLOCKING_COMMENTS";
        unresolvedComments = unresolved;
      } else {
        status = "RESOLVED_COMMENTS";
      }
    } else if (approvals.length > 0) {
      status = "RESOLVED_COMMENTS";
    } else if (questionsOrSuggestions.length > 0) {
      // Check if questions/suggestions were addressed
      if (resolutionIndicators.length > 0) {
        status = "RESOLVED_COMMENTS";
      } else {
        status = "NEUTRAL_COMMENTS";
      }
    } else {
      status = "NEUTRAL_COMMENTS";
    }

    return {
      status,
      commentCount: reviewComments.length,
      changeRequests: requestingChanges.length,
      approvals: approvals.length,
      resolutionIndicators: resolutionIndicators.length,
      questionsOrSuggestions: questionsOrSuggestions.length,
      unresolvedComments,
      resolvedCount: resolutionIndicators.length,
    };
  }
  // OpenAI analysis
  async analyzeWithOpenAI(prompt) {
    try {
      logger.info("Sending request to OpenAI");

      const response = await this.openai.chat.completions.create({
        model: config.ai.openai.model,
        messages: [
          {
            role: "system",
            content: `You are an expert code reviewer. You MUST respond with ONLY valid JSON in the exact format specified. Do not include markdown formatting or additional text.`,
          },
          {
            role: "user",
            content: prompt,
          },
        ],
        max_tokens: config.ai.openai.maxTokens,
        temperature: config.ai.openai.temperature,
        response_format: { type: "json_object" },
      });

      const content = response.choices[0].message.content.trim();
      logger.info(`OpenAI response received (${content.length} characters)`);

      return content;
    } catch (error) {
      logger.error("OpenAI API error:", error);
      throw new Error(`OpenAI failed: ${error.message}`);
    }
  }

  // Gemini analysis
  async analyzeWithGemini(prompt) {
    try {
      logger.info("Sending request to Gemini");

      const enhancedPrompt = `${prompt}\n\nIMPORTANT: Respond ONLY with valid JSON. No markdown formatting.`;

      const result = await this.geminiModel.generateContent({
        contents: [
          {
            role: "user",
            parts: [{ text: enhancedPrompt }],
          },
        ],
        generationConfig: {
          maxOutputTokens: config.ai.gemini.maxTokens,
          temperature: config.ai.gemini.temperature,
        },
      });

      const response = await result.response;
      const content = response.text().trim();

      logger.info(`Gemini response received (${content.length} characters)`);

      return content;
    } catch (error) {
      logger.error("Gemini API error:", error);
      throw new Error(`Gemini failed: ${error.message}`);
    }
  }

  // Parse AI analysis response
  parseAnalysisResponse(responseText) {
    let originalResponse = "";
    let cleanedResponse = "";

    try {
      if (!responseText || typeof responseText !== "string") {
        throw new Error(
          "Invalid response: empty or non-string response received from AI"
        );
      }

      originalResponse = responseText;
      cleanedResponse = responseText.trim();

      // Step 1: Remove markdown formatting
      cleanedResponse = cleanedResponse.replace(/```json\s*/g, "");
      cleanedResponse = cleanedResponse.replace(/```\s*/g, "");

      // Step 2: Find JSON boundaries
      const firstBraceIndex = cleanedResponse.indexOf("{");
      const lastBraceIndex = cleanedResponse.lastIndexOf("}");

      if (firstBraceIndex === -1 || lastBraceIndex === -1) {
        throw new Error("No valid JSON object found in response");
      }

      cleanedResponse = cleanedResponse.substring(
        firstBraceIndex,
        lastBraceIndex + 1
      );

      // Step 3: Parse JSON
      const analysis = JSON.parse(cleanedResponse);

      // Step 4: Validate structure
      this.validateAndNormalizeAnalysis(analysis);

      logger.info("Successfully parsed and validated AI analysis response");
      return analysis;
    } catch (error) {
      logger.error("Failed to parse AI response", { error: error.message });
      return this.createParsingErrorFallback(
        error.message,
        originalResponse,
        cleanedResponse
      );
    }
  }

  // NEW: Parse fix suggestion response
  parseFixSuggestionResponse(responseText) {
    try {
      if (!responseText || typeof responseText !== "string") {
        throw new Error(
          "Invalid response: empty or non-string response received from AI"
        );
      }

      let cleanedResponse = responseText.trim();

      // Remove markdown formatting
      cleanedResponse = cleanedResponse.replace(/```json\s*/g, "");
      cleanedResponse = cleanedResponse.replace(/```\s*/g, "");

      // Find JSON boundaries
      const firstBraceIndex = cleanedResponse.indexOf("{");
      const lastBraceIndex = cleanedResponse.lastIndexOf("}");

      if (firstBraceIndex === -1 || lastBraceIndex === -1) {
        throw new Error(
          "No valid JSON object found in fix suggestion response"
        );
      }

      cleanedResponse = cleanedResponse.substring(
        firstBraceIndex,
        lastBraceIndex + 1
      );

      // Parse JSON
      const fixSuggestion = JSON.parse(cleanedResponse);

      // Validate required fields
      this.validateFixSuggestion(fixSuggestion);

      logger.info("Successfully parsed fix suggestion response");
      return fixSuggestion;
    } catch (error) {
      logger.error("Failed to parse fix suggestion response", {
        error: error.message,
      });
      throw error;
    }
  }

  // NEW: Parse merge readiness response
  parseMergeReadinessResponse(responseText) {
    try {
      if (!responseText || typeof responseText !== "string") {
        throw new Error(
          "Invalid response: empty or non-string response received from AI"
        );
      }

      let cleanedResponse = responseText.trim();

      // Remove markdown formatting
      cleanedResponse = cleanedResponse.replace(/```json\s*/g, "");
      cleanedResponse = cleanedResponse.replace(/```\s*/g, "");

      // Find JSON boundaries
      const firstBraceIndex = cleanedResponse.indexOf("{");
      const lastBraceIndex = cleanedResponse.lastIndexOf("}");

      if (firstBraceIndex === -1 || lastBraceIndex === -1) {
        throw new Error(
          "No valid JSON object found in merge readiness response"
        );
      }

      cleanedResponse = cleanedResponse.substring(
        firstBraceIndex,
        lastBraceIndex + 1
      );

      // Parse JSON
      const mergeAssessment = JSON.parse(cleanedResponse);

      // Validate required fields
      this.validateMergeAssessment(mergeAssessment);

      logger.info("Successfully parsed merge readiness response");
      return mergeAssessment;
    } catch (error) {
      logger.error("Failed to parse merge readiness response", {
        error: error.message,
      });
      throw error;
    }
  }

  // Validate and normalize analysis structure
  validateAndNormalizeAnalysis(analysis) {
    const requiredFields = [
      "prInfo",
      "automatedAnalysis",
      "humanReviewAnalysis",
      "reviewAssessment",
      "recommendation",
    ];

    for (const field of requiredFields) {
      if (!analysis[field]) {
        analysis[field] = this.getDefaultFieldValue(field);
      }
    }

    // Normalize automatedAnalysis
    if (!analysis.automatedAnalysis.severityBreakdown) {
      analysis.automatedAnalysis.severityBreakdown = {
        blocker: 0,
        critical: 0,
        major: 0,
        minor: 0,
        info: 0,
      };
    }

    if (!analysis.automatedAnalysis.categories) {
      analysis.automatedAnalysis.categories = {
        bugs: 0,
        vulnerabilities: 0,
        securityHotspots: 0,
        codeSmells: 0,
      };
    }

    // Normalize detailedFindings
    if (!Array.isArray(analysis.detailedFindings)) {
      analysis.detailedFindings = [];
    }

    // Normalize each finding
    analysis.detailedFindings = analysis.detailedFindings.map(
      (finding, index) => {
        return {
          file: String(finding.file || `unknown-file-${index}`),
          line: Number(finding.line || 1),
          issue: String(finding.issue || "No description provided"),
          severity: this.normalizeSeverity(finding.severity),
          category: this.normalizeCategory(finding.category),
          suggestion: String(finding.suggestion || "No suggestion provided"),
        };
      }
    );

    // Ensure numeric fields
    analysis.automatedAnalysis.totalIssues =
      Number(analysis.automatedAnalysis.totalIssues) || 0;
    analysis.automatedAnalysis.technicalDebtMinutes =
      Number(analysis.automatedAnalysis.technicalDebtMinutes) || 0;

    // Validate review assessment
    const validAssessments = [
      "PROPERLY REVIEWED",
      "NOT PROPERLY REVIEWED",
      "REVIEW REQUIRED",
    ];
    if (!validAssessments.includes(analysis.reviewAssessment)) {
      analysis.reviewAssessment = "REVIEW REQUIRED";
    }
  }

  // NEW: Validate fix suggestion structure
  validateFixSuggestion(fixSuggestion) {
    const requiredFields = [
      "file",
      "line",
      "issue",
      "severity",
      "category",
      "suggested_fix",
      "explanation",
    ];

    for (const field of requiredFields) {
      if (!fixSuggestion[field]) {
        throw new Error(`Missing required field '${field}' in fix suggestion`);
      }
    }

    // Normalize fields
    fixSuggestion.line = Number(fixSuggestion.line) || 1;
    fixSuggestion.current_code = String(fixSuggestion.current_code || "");
    fixSuggestion.suggested_fix = String(fixSuggestion.suggested_fix || "");
    fixSuggestion.explanation = String(fixSuggestion.explanation || "");
    fixSuggestion.additional_considerations = String(
      fixSuggestion.additional_considerations || ""
    );
    fixSuggestion.estimated_effort = String(
      fixSuggestion.estimated_effort || "15 minutes"
    );
    fixSuggestion.confidence = String(fixSuggestion.confidence || "medium");
  }

  // NEW: Validate merge assessment structure
  validateMergeAssessment(mergeAssessment) {
    const requiredFields = ["status", "reason", "recommendation"];

    for (const field of requiredFields) {
      if (!mergeAssessment[field]) {
        throw new Error(
          `Missing required field '${field}' in merge assessment`
        );
      }
    }

    // Validate status
    const validStatuses = [
      "READY_FOR_MERGE",
      "NOT_READY_FOR_MERGE",
      "REVIEW_REQUIRED",
    ];
    if (!validStatuses.includes(mergeAssessment.status)) {
      mergeAssessment.status = "REVIEW_REQUIRED";
    }

    // Normalize fields
    mergeAssessment.outstanding_issues =
      mergeAssessment.outstanding_issues || [];
    mergeAssessment.review_quality_assessment =
      mergeAssessment.review_quality_assessment || {};
    mergeAssessment.merge_readiness_score =
      Number(mergeAssessment.merge_readiness_score) || 50;
    mergeAssessment.confidence = String(mergeAssessment.confidence || "medium");
  }

  // Get default value for missing fields
  getDefaultFieldValue(fieldName) {
    const defaults = {
      prInfo: {
        prId: "unknown",
        title: "Unknown",
        repository: "unknown/unknown",
        author: "unknown",
        reviewers: [],
        url: "#",
      },
      automatedAnalysis: {
        totalIssues: 0,
        severityBreakdown: {
          blocker: 0,
          critical: 0,
          major: 0,
          minor: 0,
          info: 0,
        },
        categories: {
          bugs: 0,
          vulnerabilities: 0,
          securityHotspots: 0,
          codeSmells: 0,
        },
        technicalDebtMinutes: 0,
      },
      humanReviewAnalysis: {
        reviewComments: 0,
        issuesAddressedByReviewers: 0,
        securityIssuesCaught: 0,
        codeQualityIssuesCaught: 0,
      },
      reviewAssessment: "REVIEW REQUIRED",
      recommendation: "Unable to generate recommendation",
      detailedFindings: [],
    };

    return defaults[fieldName] || null;
  }

  // Normalize severity values
  normalizeSeverity(severity) {
    const severityStr = String(severity || "INFO").toUpperCase();
    const validSeverities = ["BLOCKER", "CRITICAL", "MAJOR", "MINOR", "INFO"];
    return validSeverities.includes(severityStr) ? severityStr : "INFO";
  }

  // Normalize category values
  normalizeCategory(category) {
    const categoryStr = String(category || "CODE_SMELL").toUpperCase();
    const validCategories = [
      "BUG",
      "VULNERABILITY",
      "SECURITY_HOTSPOT",
      "CODE_SMELL",
    ];
    return validCategories.includes(categoryStr) ? categoryStr : "CODE_SMELL";
  }

  // NEW: Create error fix suggestion fallback
  createErrorFixSuggestion(originalFinding, errorMessage) {
    return {
      file: originalFinding.file,
      line: originalFinding.line,
      issue: originalFinding.issue,
      severity: originalFinding.severity,
      category: originalFinding.category,
      current_code: "// Unable to retrieve current code",
      suggested_fix: "// Unable to generate fix suggestion due to AI error",
      explanation: `Error generating fix suggestion: ${errorMessage}`,
      additional_considerations:
        "Manual review required due to AI service error.",
      estimated_effort: "Unknown",
      confidence: "low",
      error: true,
      error_message: errorMessage,
    };
  }

  // NEW: Create error merge assessment fallback
  createErrorMergeAssessment(errorMessage) {
    return {
      status: "REVIEW_REQUIRED",
      reason: `Unable to assess merge readiness due to AI service error: ${errorMessage}`,
      recommendation:
        "Manual review required. Check AI service logs and configuration.",
      outstanding_issues: [
        {
          type: "SYSTEM",
          severity: "MAJOR",
          description: `AI merge assessment failed: ${errorMessage}`,
          file: "system",
          line: 0,
          addressed: false,
        },
      ],
      review_quality_assessment: {
        human_review_coverage: "UNKNOWN",
        ai_analysis_coverage: "FAILED",
        critical_issues_addressed: false,
        security_issues_addressed: false,
        total_unresolved_issues: 1,
      },
      merge_readiness_score: 0,
      confidence: "low",
      error: true,
      error_message: errorMessage,
    };
  }

  // Create parsing error fallback
  createParsingErrorFallback(errorMessage, originalResponse, cleanedResponse) {
    return {
      prInfo: {
        prId: "parsing-error",
        title: "AI Response Parsing Error",
        repository: "unknown/unknown",
        author: "unknown",
        reviewers: [],
        url: "#",
      },
      automatedAnalysis: {
        totalIssues: 1,
        severityBreakdown: {
          blocker: 0,
          critical: 0,
          major: 1,
          minor: 0,
          info: 0,
        },
        categories: {
          bugs: 0,
          vulnerabilities: 0,
          securityHotspots: 0,
          codeSmells: 1,
        },
        technicalDebtMinutes: 15,
      },
      humanReviewAnalysis: {
        reviewComments: 0,
        issuesAddressedByReviewers: 0,
        securityIssuesCaught: 0,
        codeQualityIssuesCaught: 0,
      },
      reviewAssessment: "REVIEW REQUIRED",
      detailedFindings: [
        {
          file: "AI_PARSING_ERROR",
          line: 1,
          issue: `Failed to parse AI response: ${errorMessage}`,
          severity: "MAJOR",
          category: "CODE_SMELL",
          suggestion:
            "Check AI service configuration and review server logs for details.",
        },
      ],
      recommendation: `AI response parsing failed: ${errorMessage}. Please check AI provider configuration.`,
    };
  }

  // Create general error fallback
  createErrorFallbackAnalysis(errorMessage) {
    return {
      prInfo: {
        prId: "error",
        title: "AI Analysis Error",
        repository: "unknown/unknown",
        author: "unknown",
        reviewers: [],
        url: "#",
      },
      automatedAnalysis: {
        totalIssues: 1,
        severityBreakdown: {
          blocker: 0,
          critical: 1,
          major: 0,
          minor: 0,
          info: 0,
        },
        categories: {
          bugs: 0,
          vulnerabilities: 0,
          securityHotspots: 0,
          codeSmells: 1,
        },
        technicalDebtMinutes: 30,
      },
      humanReviewAnalysis: {
        reviewComments: 0,
        issuesAddressedByReviewers: 0,
        securityIssuesCaught: 0,
        codeQualityIssuesCaught: 0,
      },
      reviewAssessment: "REVIEW REQUIRED",
      detailedFindings: [
        {
          file: "AI_SERVICE_ERROR",
          line: 1,
          issue: `AI analysis service error: ${errorMessage}`,
          severity: "CRITICAL",
          category: "CODE_SMELL",
          suggestion:
            "Check AI service configuration and ensure the service is available.",
        },
      ],
      recommendation: `AI analysis encountered an error: ${errorMessage}. Please verify configuration.`,
    };
  }

  // Prepare data for AI analysis
  prepareAnalysisData(prData, existingComments) {
    const pr = prData.pr || prData || {};
    const files = prData.files || [];

    const structuredFiles = this.createStructuredFileData(files, prData.diff);

    return {
      repo_url: `https://github.com/${pr.repository}`,
      branch_name: pr.sourceBranch || "unknown",
      pr_number: pr.number,
      pr_id: pr.number,
      repository: pr.repository,
      target_branch: pr.targetBranch || "main",
      source_branch: pr.sourceBranch || "unknown",
      pr_info: {
        id: pr.id,
        number: pr.number,
        title: pr.title || "No title",
        description: pr.description || "No description",
        author: pr.author || "unknown",
        url: pr.url || "#",
        state: pr.state || "open",
        created_at: pr.created_at || new Date().toISOString(),
        updated_at: pr.updated_at || new Date().toISOString(),
        additions: pr.additions || 0,
        deletions: pr.deletions || 0,
        changed_files: files.length,
      },
      file_changes: structuredFiles,
      existing_comments: this.formatExistingComments(existingComments),
      reviewers: prData.reviewers || [],
    };
  }

  // Create structured file data
  createStructuredFileData(files, rawDiff) {
    const structuredFiles = [];

    files.forEach((file) => {
      if (!file.patch) return;

      structuredFiles.push({
        filename: file.filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
        lines: this.parseFileLines(file.patch, file.filename),
        blob_url: file.blob_url,
        raw_url: file.raw_url,
        sha: file.sha,
      });
    });

    return structuredFiles;
  }

  // Parse file patch into structured lines
  parseFileLines(patch, filename) {
    const lines = patch.split("\n");
    const structuredLines = [];
    let oldLineNum = 0;
    let newLineNum = 0;

    for (const line of lines) {
      if (line.startsWith("@@")) {
        const hunkMatch = line.match(/@@\s*-(\d+),?\d*\s*\+(\d+),?\d*\s*@@/);
        if (hunkMatch) {
          oldLineNum = parseInt(hunkMatch[1]) - 1;
          newLineNum = parseInt(hunkMatch[2]) - 1;
        }
        continue;
      }

      const lineType = line.charAt(0);
      const content = line.slice(1);

      if (lineType === "-") {
        oldLineNum++;
        structuredLines.push({
          type: "deleted",
          oldLineNumber: oldLineNum,
          newLineNumber: null,
          content: content,
          commentable: false,
        });
      } else if (lineType === "+") {
        newLineNum++;
        structuredLines.push({
          type: "added",
          oldLineNumber: null,
          newLineNumber: newLineNum,
          content: content,
          commentable: true,
        });
      } else if (lineType === " ") {
        oldLineNum++;
        newLineNum++;
        structuredLines.push({
          type: "context",
          oldLineNumber: oldLineNum,
          newLineNumber: newLineNum,
          content: content,
          commentable: false,
        });
      }
    }

    return structuredLines;
  }

  // Format existing comments
  formatExistingComments(comments) {
    return comments.map((comment) => ({
      id: comment.id,
      user: comment.user,
      body: comment.body,
      created_at: comment.createdAt,
      type: comment.type,
      file: comment.path || null,
      line: comment.line || null,
    }));
  }

  // Enhance analysis with PR context
  enhanceAnalysisWithContext(analysis, prData, existingComments) {
    if (analysis.prInfo && prData.pr) {
      analysis.prInfo.prId = prData.pr.number;
      analysis.prInfo.title = prData.pr.title;
      analysis.prInfo.repository = prData.pr.repository;
      analysis.prInfo.author = prData.pr.author;
      analysis.prInfo.url = prData.pr.url;
      analysis.prInfo.reviewers = prData.reviewers || [];
    }

    if (analysis.humanReviewAnalysis) {
      analysis.humanReviewAnalysis.reviewComments = existingComments.length;
    }

    return analysis;
  }

  // Check AI service health
  async checkHealth() {
    try {
      const testPrompt = `{"status": "OK", "test": true}`;

      if (this.provider === "openai" && this.openai) {
        const response = await this.openai.chat.completions.create({
          model: config.ai.openai.model,
          messages: [
            { role: "user", content: `Return exactly: ${testPrompt}` },
          ],
          max_tokens: 50,
          response_format: { type: "json_object" },
        });

        const content = response.choices[0].message.content.trim();
        const parsed = JSON.parse(content);
        return parsed.status === "OK";
      } else if (this.provider === "gemini" && this.geminiModel) {
        const result = await this.geminiModel.generateContent(
          `Return exactly: ${testPrompt}`
        );
        const response = await result.response;
        const content = response.text().trim();
        const parsed = JSON.parse(content);
        return parsed.status === "OK";
      }

      return false;
    } catch (error) {
      logger.error("AI health check failed:", error);
      return false;
    }
  }

  // NEW: Add the checkMergeReadiness method
  async checkMergeReadiness(analysis, checkRunData) {
    try {
      logger.info(`Checking merge readiness for analysis`, {
        trackingId: analysis.trackingId,
      });

      // Get PR data from checkRunData if available
      const prData = checkRunData.prData || {
        pr: {
          number: checkRunData.pullNumber,
          repository: `${checkRunData.owner}/${checkRunData.repo}`,
          mergeable: true,
          mergeable_state: "clean",
        },
        files: [],
        comments: [],
      };

      const aiFindings = analysis.detailedFindings || [];
      const reviewComments = [];
      const currentStatus = {
        mergeable: true,
        merge_state: "clean",
        review_decision: null,
      };

      // Use the existing assessMergeReadiness method instead of duplicating logic
      const mergeAssessment = await this.assessMergeReadiness(
        prData,
        aiFindings,
        reviewComments,
        currentStatus
      );

      logger.info(
        `Merge readiness assessment completed: ${mergeAssessment.status}`,
        {
          score: mergeAssessment.merge_readiness_score,
          trackingId: analysis.trackingId,
        }
      );

      // Format the response for the check run
      return {
        isReady: mergeAssessment.status === "READY_FOR_MERGE",
        summary: `${mergeAssessment.status}: ${mergeAssessment.reason}`,
        details: this.formatMergeReadinessDetails(mergeAssessment),
        status: mergeAssessment.status,
        score: mergeAssessment.merge_readiness_score,
        recommendation: mergeAssessment.recommendation,
      };
    } catch (error) {
      logger.error("Error in checkMergeReadiness:", error);
      throw new Error(`Failed to check merge readiness: ${error.message}`);
    }
  }

  // Add this helper method to format the details
  formatMergeReadinessDetails(mergeAssessment) {
    let details = `## Merge Readiness Assessment\n\n`;
    details += `**Status:** ${mergeAssessment.status}\n`;
    details += `**Score:** ${mergeAssessment.merge_readiness_score}/10\n`;
    details += `**Confidence:** ${mergeAssessment.confidence}\n\n`;
    details += `**Reason:** ${mergeAssessment.reason}\n\n`;
    details += `**Recommendation:** ${mergeAssessment.recommendation}\n\n`;

    if (
      mergeAssessment.outstanding_issues &&
      mergeAssessment.outstanding_issues.length > 0
    ) {
      details += `### Outstanding Issues (${mergeAssessment.outstanding_issues.length})\n`;
      mergeAssessment.outstanding_issues.forEach((issue, index) => {
        const issueText =
          typeof issue === "string"
            ? issue
            : issue.description || issue.message || JSON.stringify(issue);
        details += `${index + 1}. ${issueText}\n`;
      });
      details += "\n";
    }

    if (mergeAssessment.review_quality_assessment) {
      details += `### Review Quality Assessment\n`;
      const qa = mergeAssessment.review_quality_assessment;
      details += `- Human Review Coverage: ${
        qa.human_review_coverage || "Unknown"
      }\n`;
      details += `- AI Analysis Coverage: ${
        qa.ai_analysis_coverage || "Complete"
      }\n`;
      details += `- Critical Issues Addressed: ${
        qa.critical_issues_addressed ? "Yes" : "No"
      }\n`;
      details += `- Security Issues Addressed: ${
        qa.security_issues_addressed ? "Yes" : "No"
      }\n`;
      details += `- Total Unresolved Issues: ${
        qa.total_unresolved_issues || 0
      }\n\n`;
    }

    return details;
  }

  async callAI(prompt, responseFormat) {
    if (this.provider === "openai" && this.openai) {
      const response = await this.openai.chat.completions.create({
        model: config.ai.openai.model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 4096,
        response_format: { type: responseFormat },
      });
      return response.choices[0].message.content;
    } else if (this.provider === "gemini" && this.geminiModel) {
      const result = await this.geminiModel.generateContent(prompt);
      const response = await result.response;
      return response.text();
    }
    throw new Error("No AI provider configured or initialized.");
  }

  parseAIResponse(responseText) {
    const cleanedText = responseText
      .replace(/```json/g, "")
      .replace(/```/g, "");
    if (!isValidJSON(cleanedText)) {
      throw new Error("AI returned invalid JSON.");
    }
    return JSON.parse(cleanedText);
  }

  processAIAnalysis(parsedResponse, prData) {
    const analysis = {
      trackingId: generateTrackingId(),
      timestamp: new Date().toISOString(),
      prInfo: {
        pullNumber: prData.pullNumber,
        repository: prData.pr.repository,
        author: prData.pr.author,
        url: prData.pr.url,
        reviewers: prData.reviewers || [],
      },
      ...parsedResponse,
    };
    if (analysis.humanReviewAnalysis) {
      analysis.humanReviewAnalysis.reviewComments =
        prData.existingComments.length;
    }
    return analysis;
  }
}

module.exports = new AIService();
