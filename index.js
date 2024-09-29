const http = require('http')
const express = require('express')
const httpProxy = require('http-proxy')
const Docker = require('dockerode')

const proxy = httpProxy.createProxy({})
const db = new Map()
const docker = new Docker({socketPath: "/var/run/docker.sock"})

docker.getEvents(function (err, stream) {
    if (err) {
        console.log(`Error in getting events`, err)
        return
    }
    stream.on('data', async(chunk) => {
        if (!chunk) return
        const event = JSON.parse(chunk.toString())

        if (event.Type === "container" && event.Action == "start") {
            const container = docker.getContainer(event.id)
            const containerInfo = await container.inspect()

            const containerName = containerInfo.Name.substring(1)
            const ipAddress = containerInfo.NetworkSettings.IPAddress

            const exposedPort = Object.keys(containerInfo.Config.ExposedPorts)

            let defaultPort = null

            if (exposedPort && exposedPort.length > 0) {
                const [port, type] = exposedPort[0].split('/')
                if (type === 'tcp') {
                    defaultPort = port
                }
            }
            console.log(`Registering ${containerName}.localhost --> http://${ipAddress}:${defaultPort}`)
            db.set(containerName, {containerName, ipAddress, defaultPort})
        }
    })
})

const managementAPI = express()
managementAPI.use(express.json())
const reverseproxyApp = express()

reverseproxyApp.use(function (req, res) {
    const hostname = req.hostname
    const subdomain = hostname.split('.')[0]

    if (!db.has(subdomain)) return res.status(404).end()

    const { ipAddress, defaultPort } = db.get(subdomain)
    const target = `http://${ipAddress}:${defaultPort}`

    console.log(`Forwarding ${hostname}-> ${proxy}`)

    return proxy.web(req, res, {target, changeOrigin: true})
})

const reverseproxy = http.createServer(reverseproxyApp)

managementAPI.post('/containers', async (req, res) => {
    const { image, tag = 'latest' } = req.body
    let imageAlreadyExists = false
    const images = await docker.listImages()

    for (const systemImage of images) {
        for (const systemTag of systemImage.RepoTags) {
            if (systemTag === `${image}:${tag}`) {
                imageAlreadyExists = true
                break
            }
        }
        if (imageAlreadyExists) break
    }

    if (!imageAlreadyExists) {
        console.log(`Pulling image: ${image}:${tag}`)
        await docker.pull(`${image}:${tag}`)
    }

    const container = await docker.createContainer({
        Image: `${image}:${tag}`,
        Tty: false,
        HostConfig: {
            AutoRemove: true,
        },
    })
    await container.start()
    res.json({ status: "success", container: `${(await container.inspect()).Name}.localhost` })
})

reverseproxy.listen(80, () => {
    console.log(`Reverse proxy running at port 80`)
})
