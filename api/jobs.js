const { CanvasFactory } = require("pdf-parse/worker");
const { PDFParse } = require("pdf-parse");

const REPO = "ravikumarundapalli/ravi-info";
const RESUME_PATH = "resume.pdf";

const RESUME_API =
  `https://api.github.com/repos/${REPO}/contents/${RESUME_PATH}?ref=main`;

const ADZUNA_BASE =
  "https://api.adzuna.com/v1/api/jobs/in/search";

const LOCATION = process.env.JOB_LOCATION || "Hyderabad";

const MAX_JOB_AGE_HOURS = 24;
const MAX_RESULTS = 10;

const SKILLS = [
  "aws", "azure", "gcp", "s3", "redshift", "glue", "appflow",
  "step functions", "lambda", "emr", "athena", "kinesis", "dynamodb",
  "fivetran", "hvr", "informatica", "apache nifi", "nifi", "python",
  "sql", "pyspark", "spark", "databricks", "delta", "snowflake", "dbt",
  "kafka", "etl", "data ingestion", "data pipelines", "data engineering",
  "data integration", "production support", "production troubleshooting",
  "cdc", "change data capture", "unix", "shell"
];

const ROLE_TERMS = [
  "data engineer", "etl developer", "aws data engineer", "cloud data engineer",
  "data integration engineer", "data platform engineer", "python data engineer",
  "pyspark data engineer", "aws glue data engineer"
];

function json(res, status, body) {
  res.status(status);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.end(JSON.stringify(body));
}

function normalizeText(value) {
  return String(value || "").toLowerCase();
}

function calculateScore(job, resumeText) {
  const jobText = normalizeText(
    `${job.title || ""} ${job.description || ""} ${job.category || ""} ${job.company?.display_name || ""}`
  );

  const resume = normalizeText(resumeText);
  let score = 0;
  let matchedSkills = 0;

  for (const skill of SKILLS) {
    if (resume.includes(skill) && jobText.includes(skill)) {
      score += 4;
      matchedSkills++;
    }
  }

  for (const role of ROLE_TERMS) {
    if (resume.includes(role) && jobText.includes(role)) {
      score += 10;
    }
  }

  if (jobText.includes("data engineer")) score += 8;
  if (jobText.includes("etl")) score += 5;
  if (jobText.includes("aws")) score += 4;
  if (jobText.includes("python")) score += 3;
  if (jobText.includes("sql")) score += 3;
  if (jobText.includes("pyspark")) score += 3;

  return {
    matchPercentage: Math.min(99, Math.max(50, 50 + score)),
    matchedSkills
  };
}

function hoursSince(dateValue) {
  const timestamp = new Date(dateValue).getTime();

  if (!Number.isFinite(timestamp)) {
    return Infinity;
  }

  const hours =
    (Date.now() - timestamp) / (1000 * 60 * 60);

  return Math.max(0, hours);
}

function formatAge(hours) {
  if (!Number.isFinite(hours)) {
    return "Recently posted";
  }

  if (hours < 1) {
    const minutes = Math.round(hours * 60);

    if (minutes <= 0) {
      return "Just now";
    }

    return `${minutes} min ago`;
  }

  return `${Math.round(hours)}h ago`;
}

/*
 * Only expose an employer/source URL when the provider itself supplies
 * a URL that is clearly external to Adzuna.
 *
 * Adzuna's documented redirect_url points to Adzuna, so it is deliberately
 * rejected. We do not scrape, guess, construct, or transform URLs.
 */
function getVerifiedEmployerUrl(job) {
  const candidates = [
    job.source_url,
    job.sourceUrl,
    job.employer_url,
    job.employerUrl,
    job.application_url,
    job.applicationUrl,
    job.job_url,
    job.jobUrl
  ];

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "string") {
      continue;
    }

    try {
      const parsed = new URL(candidate);
      const host = parsed.hostname
        .toLowerCase()
        .replace(/^www\./, "");

      const isAdzuna =
        host === "adzuna.in" ||
        host.endsWith(".adzuna.in") ||
        host === "adzuna.co.uk" ||
        host.endsWith(".adzuna.co.uk") ||
        host === "adzuna.com" ||
        host.endsWith(".adzuna.com");

      if (!host || isAdzuna) {
        continue;
      }

      return parsed.toString();
    } catch (_) {
      // Ignore malformed or unverified URLs.
    }
  }

  return null;
}

async function fetchResume() {
  const response = await fetch(RESUME_API, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "Ravi-Info-Job-Radar"
    },
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(
      `Unable to read resume from GitHub: ${response.status}`
    );
  }

  const data = await response.json();

  if (!data.content) {
    throw new Error(
      "GitHub did not return resume content."
    );
  }

  const pdfBuffer = Buffer.from(
    data.content.replace(/\n/g, ""),
    "base64"
  );

  const parser = new PDFParse({
    data: pdfBuffer,
    CanvasFactory
  });

  const parsed = await parser.getText();

  await parser.destroy();

  return {
    text: parsed.text || "",
    sha: data.sha || null
  };
}

async function fetchJobs() {
  const appId = process.env.ADZUNA_APP_ID;
  const appKey = process.env.ADZUNA_APP_KEY;

  if (!appId || !appKey) {
    throw new Error(
      "Missing ADZUNA_APP_ID or ADZUNA_APP_KEY environment variables."
    );
  }

  const searches = [
    "data engineer",
    "ETL developer",
    "AWS data engineer",
    "AWS Glue",
    "data integration",
    "data ingestion",
    "Python data engineer",
    "PySpark data engineer",
    "cloud data engineer",
    "data pipeline engineer"
  ];

  const allJobs = [];
  const searchDiagnostics = [];

  for (const searchTerm of searches) {
    const url = new URL(
      `${ADZUNA_BASE}/1`
    );

    url.searchParams.set("app_id", appId);
    url.searchParams.set("app_key", appKey);
    url.searchParams.set("results_per_page", "20");
    url.searchParams.set("what", searchTerm);
    url.searchParams.set("where", LOCATION);
    url.searchParams.set("sort_by", "date");
    url.searchParams.set("max_days_old", "1");
    url.searchParams.set("content-type", "application/json");

    try {
      const response = await fetch(
        url.toString(),
        {
          headers: {
            Accept: "application/json"
          },
          cache: "no-store"
        }
      );

      if (!response.ok) {
        searchDiagnostics.push({
          search: searchTerm,
          results: 0,
          status: response.status
        });

        continue;
      }

      const data = await response.json();
      const results = Array.isArray(data.results)
        ? data.results
        : [];

      searchDiagnostics.push({
        search: searchTerm,
        results: results.length,
        status: response.status
      });

      allJobs.push(...results);
    } catch (_) {
      searchDiagnostics.push({
        search: searchTerm,
        results: 0,
        status: 0,
        error: "Request failed"
      });
    }
  }

  return {
    jobs: allJobs,
    diagnostics: searchDiagnostics
  };
}

function normalizeJobs(jobs, resumeText) {
  const seen = new Set();
  const output = [];

  for (const job of jobs) {
    const ageHours = hoursSince(job.created);

    if (
      !Number.isFinite(ageHours) ||
      ageHours > MAX_JOB_AGE_HOURS
    ) {
      continue;
    }

    const title =
      job.title ||
      "Data Engineering Role";

    const company =
      job.company?.display_name ||
      "Company not listed";

    const location =
      job.location?.display_name ||
      LOCATION;

    const key =
      job.id ||
      `${title}-${company}-${location}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);

    const score = calculateScore(
      job,
      resumeText
    );

    const verifiedEmployerUrl =
      getVerifiedEmployerUrl(job);

    output.push({
      id: key,
      title,
      company,
      location,
      source: "Adzuna",
      postedAt: job.created || null,
      postedAgeHours: Number(
        ageHours.toFixed(2)
      ),
      postedAge: formatAge(ageHours),
      matchPercentage:
        score.matchPercentage,
      matchedSkills:
        score.matchedSkills,

      /*
       * The frontend should render Apply only when this field is present.
       * Current Adzuna redirect_url is intentionally NOT copied here.
       */
      employerUrl:
        verifiedEmployerUrl,

      applyAvailable:
        Boolean(verifiedEmployerUrl)
    });
  }

  output.sort((a, b) => {
    if (
      b.matchPercentage !==
      a.matchPercentage
    ) {
      return (
        b.matchPercentage -
        a.matchPercentage
      );
    }

    return (
      a.postedAgeHours -
      b.postedAgeHours
    );
  });

  return output.slice(
    0,
    MAX_RESULTS
  );
}

module.exports = async function handler(
  req,
  res
) {
  try {
    if (req.method !== "GET") {
      return json(res, 405, {
        error: "Method not allowed"
      });
    }

    const resume =
      await fetchResume();

    const jobData =
      await fetchJobs();

    const normalizedJobs =
      normalizeJobs(
        jobData.jobs,
        resume.text
      );

    return json(res, 200, {
      success: true,
      generatedAt:
        new Date().toISOString(),

      location:
        LOCATION,

      maxAgeHours:
        MAX_JOB_AGE_HOURS,

      resumeSha:
        resume.sha,

      searchDiagnostics:
        jobData.diagnostics,

      jobCount:
        normalizedJobs.length,

      jobs:
        normalizedJobs
    });
  } catch (error) {
    console.error(
      "Job Radar error:",
      error
    );

    return json(res, 500, {
      success: false,
      error:
        error.message ||
        "Unable to load jobs."
    });
  }
};
