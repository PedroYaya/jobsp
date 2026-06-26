# Jobsp

A simple tool I built for myself to filter remote job opportunities from a massive PDF list of companies and job boards collected from around the world.

The application takes my resume and a PDF containing hundreds of remote-work companies, automatically extracts the relevant data, scans company career pages using Puppeteer, and generates a report with opportunities that best match my profile.

It was originally created as a personal productivity project to avoid manually reviewing large job lists, but it can be easily configured for anyone by replacing the resume and company-list PDFs.

# Quick Start
npm install
cp .env.example .env

# Place your resume PDF and company-list PDF inside the pdfs/ folder, then generate the JSON files:

npm run import-pdfs

Start the UI:

npm run dev

Run a scan:

npm run scan

Results will be available in the browser UI and generated under public/generated/.
