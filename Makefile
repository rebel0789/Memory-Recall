.PHONY: bootstrap doctor status task test protocol eval check ci native-smoke demo dev manifest verify clean
bootstrap:
	npm run bootstrap
doctor:
	npm run doctor
status:
	npm run status
task:
	npm run task -- $(ID)
test:
	npm test
protocol:
	npm run protocol:validate
eval:
	npm run eval
check:
	npm run check
ci:
	npm run ci
native-smoke:
	npm run native:smoke
demo:
	npm run demo
dev:
	npm run dev
manifest:
	npm run manifest
verify:
	npm run verify:handoff
clean:
	rm -rf node_modules coverage
