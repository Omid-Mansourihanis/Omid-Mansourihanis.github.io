# Omid Mansourihanis — Academic Portfolio

Source for my personal academic website: **https://omid-mansourihanis.github.io/**

The site presents my research in geospatial machine learning, urban analytics, spatial justice, and sustainable development, along with my publications, professional experience, education, map presentations, and CV.

## Structure

```
.
├── index.html                              # The entire site (HTML, CSS, and a small script)
├── portfolio/
│   ├── index.html                          # Mapping and Research Portfolio (generated page)
│   └── img/                                # Portfolio figures and thumbnails
├── simulations/
│   └── covid-nowruz-sari/index.html        # Interactive COVID-19 and Nowruz simulation (standalone page)
└── assets/
    ├── documents/
    │   └── Omid-Mansourihanis-CV.pdf       # Academic CV linked from the site
    ├── images/                             # Video poster images
    └── videos/                             # Videos shown in Selected Visualizations and Projects (MP4, H.264)
```

The site is a single static page with no build step and no external dependencies. GitHub Pages serves it directly from the `main` branch.

## Updating the site

- **Publications:** each paper is an `<article class="publication">` in the `#publications` section. Set `data-type` to `published` or `review` (the latter covers manuscripts in review and preprints) so the filter buttons work, and use a matching `status` badge (`published`, `review`, or `preprint`). When you add or move a paper, update the counts in the stats bar near the top of the page as well.
- **Selected Visualizations and Projects:** put the MP4 in `assets/videos/` and a 16:9 poster image in `assets/images/`, then copy the `<article class="animation">` block in the `#animations` section. Keep each video under about 50 MB. GitHub warns above 50 MB and rejects files over 100 MB.
- **CV:** replace `assets/documents/Omid-Mansourihanis-CV.pdf` with the new file and keep the same filename so existing links keep working.
- **Preview locally:** open `index.html` in a browser, or run `python3 -m http.server` in this folder and visit http://localhost:8000.

## Contact

- Email: [omansour@ttu.edu](mailto:omansour@ttu.edu)
- [Google Scholar](https://scholar.google.com/citations?user=GrMkyjQAAAAJ&hl=en) · [ORCID](https://orcid.org/0009-0007-3009-2902) · [LinkedIn](https://www.linkedin.com/in/omid-mansourihanis14ab784/) · [ResearchGate](https://www.researchgate.net/profile/Omid-Mansourihanis)
