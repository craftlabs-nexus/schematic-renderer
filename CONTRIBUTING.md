# Contributing to schematic-renderer

Thank you for your interest in contributing to schematic-renderer! This document provides guidelines and information for contributors.

## Getting Started

### Prerequisites

- Node.js 22 and [pnpm](https://pnpm.io/) (`npm install -g pnpm`; the version is in `package.json`'s `packageManager`)
- Git

### Development Setup

1. Clone the repository:

   ```bash
   git clone https://github.com/craftlabs-nexus/schematic-renderer.git
   cd schematic-renderer
   ```

2. Install dependencies:

   ```bash
   pnpm install
   ```

3. Start the development server:

   ```bash
   pnpm run dev
   ```

4. Run tests:
   ```bash
   pnpm run test
   ```

## Development Workflow

### Code Style

This project uses ESLint and Prettier for code formatting. The configuration enforces:

- Tabs for indentation
- Double quotes for strings
- Semicolons at end of statements
- 100 character line width

Pre-commit hooks will automatically lint and format your code. You can also run manually:

```bash
pnpm run lint        # Check for linting errors
pnpm run lint:fix    # Fix linting errors
pnpm run format      # Format code with Prettier
```

### Running Tests

```bash
pnpm run test           # Run tests in watch mode
pnpm run test:run       # Run tests once
pnpm run test:coverage  # Run tests with coverage report
```

### Building

```bash
pnpm run build      # Build the library
pnpm run typecheck  # Run TypeScript type checking
```

## Pull Request Process

1. Create a feature branch from `master`:

   ```bash
   git checkout -b feature/your-feature-name
   ```

2. Make your changes and commit them with clear, descriptive messages.

3. Ensure all tests pass:

   ```bash
   pnpm run test:run
   pnpm run lint
   pnpm run typecheck
   ```

4. Push your branch and create a Pull Request.

5. Wait for CI checks to pass and request a review.

## Code of Conduct

- Be respectful and inclusive in all interactions
- Provide constructive feedback
- Focus on the code, not the person
- Help others learn and grow

## Reporting Issues

When reporting issues, please include:

- A clear description of the problem
- Steps to reproduce
- Expected vs actual behavior
- Browser/environment information
- Screenshots or error messages if applicable

## License

By contributing to this project, you agree that your contributions will be licensed under the AGPL-3.0-only license.
