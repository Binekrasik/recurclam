import { spawn, ChildProcess } from 'child_process'
import { readdirSync, openSync, mkdirSync, writeSync, existsSync, rmSync } from 'node:fs'

// configuration
const depth = 2 // recursiveness depth
const processLimit = 4 // maximum amount of active clamscan processes at once
const startDirectory = '/' // directory which the recursion will be begun from
const excludeDirs = [ // directories to exclude from scanning
    '/dev',
    '/proc',
    '/sys',
]

const getDirs = ( path: string ): string[] | null => {
    try {
        return readdirSync( path, { withFileTypes: true } )
            .filter( entry => entry.isDirectory() )
            .map( directory => {
                return `${ directory.parentPath !== '/' ? directory.parentPath : '' }/${ directory.name }`
            })
    } catch ( _ ) { return null }
}

console.log( `Scanning for directories (depth = ${ depth })...` )

let directories: Array< string[] > = [[ startDirectory ]] // start recursing from the configured directory
for ( let i = 0; i < depth; i++ ) {
    // advance in depth
    let tempDirs: string[] = []
    directories[ i ]?.forEach( dir => {
        if ( excludeDirs.includes( dir ) ) {
            console.warn( `Skipping ${ dir }: ${ dir } is listed as excluded.` )
            return
        }

        let dirs = getDirs( dir )
        if ( !dirs ) {
            console.warn( `Skipping ${ dir }: couldn't read ${ dir }.` )
            return
        }

        tempDirs = tempDirs.concat( dirs )
    })

    directories.push( tempDirs )
}

console.log( directories )
console.log( `Collected directories. Running scans...` )

if ( existsSync( '/tmp/recurclam' ) ) {
    console.warn( `Removing existing '/tmp/recurclam/' log directory.` )
    rmSync( '/tmp/recurclam', { recursive: true, force: true } )
}

mkdirSync( '/tmp/recurclam/' )

let activeWorkers: ChildProcess[] = []

let scans: Array< string[] > = []
let scansIndex = 0

directories.forEach( ( dirs, x ) => {
    dirs.forEach( dir => {
        if ( !excludeDirs.includes( dir ) ) {
            scans.push( [ dir, x + 1 == directories.length ? '--recursive=yes' : '' ] )
        } else console.log( `Will not scan excluded directory '${ dir }'` )
    })
})

const removeActiveWorker = ( worker: ChildProcess ) => {
    const index = activeWorkers.indexOf( worker )

    if ( index > -1 ) {
        activeWorkers.splice( index, 1 )
    } else console.warn( 'Tried to remove a nonexistent worker.' )
}

const spawnNextWorker = () => {
    // don't spawn more workers if we already ran all scans
    if ( scansIndex === scans.length - 1 ) return

    console.log( `Spawning worker ${ scansIndex }: clamscan ${ scans[ scansIndex ]!.join( ' ' ) }` )

    // create log file for current worker
    let log = openSync( `/tmp/recurclam/worker${ scansIndex }.log`, 'a' )

    writeSync( log, `// recurclam worker ${ scansIndex }\n` )
    writeSync( log, `// $ clamscan ${ scans[ scansIndex ]!.join( ' ' ) }\n\n` )

    const worker = spawn( 'clamscan', scans[ scansIndex ]!, {
        stdio: [ 'ignore', log, log ],
        detached: true
    })

    activeWorkers.push( worker )

    const workerId = scansIndex.toString()

    worker.on( 'close', ( _, signal: NodeJS.Signals ) => {
        removeActiveWorker( worker )

        if ( signal !== 'SIGKILL' ) {
            console.log( `Worker ${ workerId } finished.` )
            spawnNextWorker()
        } else console.warn( `Worker ${ workerId } received SIGKILL and will not spawn next worker.` )
    })

    scansIndex++
}

const advanceScans = () => {
    console.log( `Process limit is set to ${ processLimit }.` )

    for ( let i = 0; i < processLimit; i++ )
        spawnNextWorker()
}

advanceScans()

const killWorkers = () => {
    console.log( 'Terminating all workers.' )
    activeWorkers.forEach( worker => worker.kill( 'SIGKILL' ) )
}

process.on( 'SIGINT', () => {
    console.log( 'Received SIGINT.' )
    killWorkers()
})