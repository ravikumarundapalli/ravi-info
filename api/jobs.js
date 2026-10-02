const { CanvasFactory } = require("pdf-parse/worker");
const { PDFParse } = require("pdf-parse");

const REPO = "ravikumarundapalli/ravi-info";
const RESUME_PATH = "resume.pdf";

const RESUME_API =
  `https://api.github.com/repos/${REPO}/contents/${RESUME_PATH}?ref=main`;

const ADZUNA_BASE =
  "https://api.adzuna.com/v1/api/jobs/in/search";

const LOCATION = process.env.JOB_LOCATION || "Hyderabad";

const SKILLS = [
  "aws",
  "azure",
  "gcp",
  "s3",
  "redshift",
  "glue",
  "appflow",
  "step functions",
  "lambda",
  "emr",
  "athena",
  "kinesis",
  "dynamodb",
  "fivetran",
  "hvr",
  "informatica",
  "apache nifi",
  "nifi",
  "python",
  "sql",
  "pyspark",
  "spark",
  "databricks",
  "delta",
  "snowflake",
  "dbt",
  "kafka",
  "etl",
  "data ingestion",
  "data pipelines",
  "data engineering",
  "data integration",
  "production support",
  "production troubleshooting",
  "cdc",
  "change data capture",
  "unix",
  "shell"
];

const ROLE_TERMS = [
  "data engineer",
  "etl developer",
  "aws data engineer",
  "cloud data engineer",
  "data integration engineer",
  "data platform engineer",
  "python data engineer",
  "pyspark data engineer",
  "aws glue data engineer"
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
    `${job.title} ${job.description} ${job.category} ${job.company}`
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

  const matchPercentage = Math.min(
    99,
    Math.max(50, 50 + score)
  );

  return {
    matchPercentage,
    matchedSkills
  };
}

function hoursSince(dateValue) {
  const timestamp = new Date(dateValue).getTime();

  if (!Number.isFinite(timestamp)) {
    return Infinity;
  }

  return (Date.now() - timestamp) / (1000 * 60 * 60);
}

function formatAge(hours) {
  if (!Number.isFinite(hours)) {
    return "Recently posted";
  }

  if (hours < 1) {
    return `${Math.max(1, Math.round(hours * 60))} min ago`;
  }

  return `${Math.round(hours)}h ago`;
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
    throw new Error("GitHub did not return resume content.");
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
    "cloud data engineer"
  ];

  const allJobs = [];

  for (const searchTerm of searches) {
    const url = new URL(`${ADZUNA_BASE}/1`);

    url.searchParams.set("app_id", appId);
    url.searchParams.set("app_key", appKey);
    url.searchParams.set("results_per_page", "20");
    url.searchParams.set("what", searchTerm);
    url.searchParams.set("where", LOCATION);
    url.searchParams.set("sort_by", "date");
    url.searchParams.set("max_days_old", "1");
    url.searchParams.set("content-type", "application/json");

    const response = await fetch(url.toString(), {
      headers: {
        Accept: "application/json"
      },
      cache: "no-store"
    });

    if (!response.ok) {
      continue;
    }

    const data = await response.json();

    if (Array.isArray(data.results)) {
      allJobs.push(...data.results);
    }
  }

  return allJobs;
}

function normalizeJobs(jobs, resumeText) {
  const seen = new Set();
  const output = [];

  for (const job of jobs) {
    const ageHours = hoursSince(job.created);

    if (ageHours > 24) {
      continue;
    }

    const title = job.title || "Data Engineering Role";
    const company = job.company?.display_name || "Company not listed";
    const location =
      job.location?.display_name || LOCATION;

    const key =
      job.id ||
      `${title}-${company}-${location}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);

    const score = calculateScore(job, resumeText);

    output.push({
      id: key,
      title,
      company,
      location,
      source: "Adzuna",
      postedAt: job.created || null,
      postedAgeHours: Number(ageHours.toFixed(2)),
      postedAge: formatAge(ageHours),
      matchPercentage: score.matchPercentage,
      matchedSkills: score.matchedSkills,
      url: job.redirect_url || null
    });
  }

  output.sort((a, b) => {
    if (b.matchPercentage !== a.matchPercentage) {
      return b.matchPercentage - a.matchPercentage;
    }

    return a.postedAgeHours - b.postedAgeHours;
  });

  return output.slice(0, 10);
}

module.exports = async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      return json(res, 405, {
        error: "Method not allowed"
      });
    }

    const resume = await fetchResume();

    const jobs = await fetchJobs();

    const normalizedJobs = normalizeJobs(
      jobs,
      resume.text
    );

    return json(res, 200, {
      success: true,
      generatedAt: new Date().toISOString(),
      location: LOCATION,
      maxAgeHours: 24,
      resumeSha: resume.sha,
      jobCount: normalizedJobs.length,
      jobs: normalizedJobs
    });

  } catch (error) {
    console.error("Job Radar error:", error);

    return json(res, 500, {
      success: false,
      error: error.message || "Unable to load jobs."
    });
  }
};
